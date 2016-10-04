
import * as Protocol from "./Protocol";
import {EventEmitter} from "./EventEmitter";


export interface ILocalTypeInfo extends Protocol.ITypeInfo {
    prototype: { new (): any };
}

interface IPromiseInfo {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
}

export interface IHyperJumpEventHandler {
    (source: any, ...args: any[]): void;
}

export interface IRemoteObjectInfo {
    events: Map<string, Set<IHyperJumpEventHandler>>;
    obj: any;
}

// hack to use either the native browser WebSocket or nodejs' ws.
var WebSocketClass: any;
try {
    WebSocketClass = WebSocket;
}
catch (e) { }

if (WebSocketClass === undefined) 
    WebSocketClass = require("ws");

const PING_OBJECTS_PERIOD = 60 * 1000;

export class HyperjumpClient extends EventEmitter {

    private socket: WebSocket;
    private root_: Protocol.IRoot
    private objecIds = new WeakMap<any, number>();
    private typesByName = new Map<string, ILocalTypeInfo>();
    private types = new WeakMap<Function, ILocalTypeInfo>();
    private calls = new Map<number, IPromiseInfo>();
    private tracklist = new Map<number, IRemoteObjectInfo>();
    private binaryBufferList = new Map<number, ArrayBuffer>();
    private nextBinaryDataHeaderCommand: Protocol.IBinaryDataHeaderCommand;
    private debugMethodList: Map<number, string>;
    public debugMode = false;


    private log = {
        log: function (type: string, st: string) {
            console.log(`hyperjump-client [${type}]: ${st}`);
        },
        info: function (st: string) {
            if (this.loglevel >= 3)
                this.log("INFO", st);
        },
        warn: function (st: string) {
            if (this.loglevel >= 2)
                this.log("WARN", st);
        },
        error: function (st: string) {
            if (this.loglevel >= 1)
                this.log("ERROR", st);
        },
        loglevel: 1
    }
    constructor() {
        super();
        this.registerTypeInfo(Date, Protocol.DateTypeInfo as ILocalTypeInfo);
        this.registerTypeInfo(Map,Protocol.MapTypeInfo as ILocalTypeInfo);
    }

    get loglevel() {
        return this.log.loglevel;
    }

    set loglevel(level: number) {
        this.log.loglevel = level;
    }

    private debug(...args: any[]) {
        if (this.debugMode)
            console.log.apply(console, arguments);
    }

    public connect(url: string) {

        this.socket = new WebSocketClass(url);
        this.socket.binaryType = "arraybuffer";

        if (this.debugMode) {
            this.debugMethodList = new Map<number, string>();
        }

        this.socket.onopen = async () => {
            this.log.info("socket open");
            this.emit("onopen");
            //obtain a reference to the root object
            let root = { _byRef: 0 };
            this.root_ = await this.invokeRemoteFunction(Protocol.ROOT_FUNCTION_GET_OBJECT, root, [0] as any)
            this.emit("ready");

            this.schedulePing();

        };

        this.socket.onmessage = (event) => {
            if (typeof event.data === "string")
                this.processMessage(JSON.parse(event.data));
            else { //binary data
                if (!this.nextBinaryDataHeaderCommand) {
                    this.log.error("PROTOCOL ERROR: Binary data received without header");
                    return;
                }
                let buf = event.data as ArrayBuffer;
                if (buf.byteLength != this.nextBinaryDataHeaderCommand.length) {
                    this.log.error("PROTOCOL ERROR: Binary data received length mismatch");
                    return;
                }

                this.binaryBufferList.set(this.nextBinaryDataHeaderCommand.id, buf);
                this.nextBinaryDataHeaderCommand = undefined;
            }
        };

        this.socket.onerror = (ev) => {
            this.log.error("Socket error " + (ev as any).code);
        }

        this.socket.onclose = () => {
            this.log.warn("Socket closed")
            setTimeout(() => {
                this.connect(url);
            }, 5000);
        }
    }

    public get root(): Protocol.IRoot {
        return this.root_;
    }

    public registerTypeInfo(type: Function, typeInfo: ILocalTypeInfo) {
        this.types.set(type, typeInfo);
        this.typesByName.set(type.name, typeInfo);
    }

    private schedulePing() {
        setInterval(() => {
            this.root_.pingObjects([...this.tracklist.keys()]);

        }, PING_OBJECTS_PERIOD);
    }


    private processMessage(cmd: Protocol.ICommand) {
        this.debug("HyperjumpClient.processMessage", cmd);
        switch (cmd.command) {
            case "result": this.process_result(cmd as Protocol.IInvokeResultCommand); break;
            case "event": this.process_event(cmd as Protocol.IEventFiredCommand); break;
            case "buffer": this.process_buffer(cmd as Protocol.IBinaryDataHeaderCommand); break;
            default: {
                log.warn("Unknown cmd type " + cmd.command);
            }
        }
    }

    private makeFunction(funcDef: Protocol.IFunctionDefinition): Function {
        return new Function(...funcDef.args, funcDef.body);
    }

    private makeType(typeInfo: Protocol.ITypeInfo): ILocalTypeInfo {
        let localTypeInfo = typeInfo as ILocalTypeInfo;
        let Proto = function (): any { };
        //Proto["_type"] = typeInfo.name;

        for (var methodName of Object.keys(typeInfo.methods)) {
            let functionId = typeInfo.methods[methodName];
            Proto.prototype[methodName] = this.generateProxyFunction(functionId);
            if (this.debugMode) {
                this.debugMethodList.set(functionId, typeInfo.name + "." + methodName);
            }
        }

        for (var methodName of Object.keys(typeInfo.clientMethods)) {
            let clientMethodInfo = typeInfo.clientMethods[methodName];
            Proto.prototype[methodName] = this.makeFunction(clientMethodInfo);
        }

        if (typeInfo.serializationInfo) {
            typeInfo.serializationInfo.deserialize = this.makeFunction(typeInfo.serializationInfo.deserializerDef) as any;
            typeInfo.serializationInfo.serialize = this.makeFunction(typeInfo.serializationInfo.serializerDef) as any;
        }

        localTypeInfo.prototype = Proto as any;

        this.typesByName.set(typeInfo.name, localTypeInfo);
        this.types.set(Proto, localTypeInfo);
        return localTypeInfo;
    }

    private async getType(typeName: string): Promise<Function> {
        let typeInfo = this.typesByName.get(typeName);
        if (typeInfo) {
            return typeInfo.prototype;
        }

        return new Promise<Function>((resolve, reject) => {

            let typeReceived = (typeInfo?: Protocol.ITypeInfo) => {
                let localTypeInfo = this.makeType(typeInfo);
                resolve(localTypeInfo.prototype);

            }

            let typeNotFound = (err: Error) => {
                reject(err);
            }

            this.idCall++;
            this.calls.set(this.idCall, { resolve: typeReceived, reject: typeNotFound });
            let cmd: Protocol.IInvokeCommand = {
                command: "invoke",
                functionId: Protocol.ROOT_FUNCTION_GET_TYPE, //getType
                callId: this.idCall,
                thisArg: { _byRef: 0 }, //Root
                args: [typeName],
            }

            if (this.debugMode) {
                cmd.debugInfo = `root.getType(${typeName})`;
            }
            this.send(cmd);


        });

    }

    private serialize(obj: any): any {

        if (Array.isArray(obj)) {
            let arr: any[] = [];
            (obj as any[]).forEach(element => {
                arr.push(this.serialize(element));
            });
            return arr;
        }

        if (obj instanceof ArrayBuffer) {

            let id = this.sendBuffer(obj as ArrayBuffer);

            return {
                _type: "Buffer",
                id: id
            }
        }

        if (typeof obj !== "object" || obj == null || obj == undefined)
            return obj; //primitive type

        let typeInfo = this.types.get(obj.constructor);

        if (typeInfo) {
            let id = this.objecIds.get(obj);
            if (id !== undefined) {
                return { _byRef: id };
            }
            if (typeInfo.serializationInfo && typeInfo.serializationInfo.serialize) {
                obj = typeInfo.serializationInfo.serialize(obj);
                obj._type = typeInfo.name;
            }

        }

        let ret: any = {};

        let keys = Object.keys(obj);
        keys.forEach(key => {
            ret[key] = this.serialize(obj[key]);
        });

        return ret;

    }

    private deserializeFast(obj: any): any {

        if (Array.isArray(obj)) {
            let arr: any[] = [];
            (obj as any[]).forEach(element => {
                arr.push(this.deserializeFast(element));
            });
            return arr;
        }

        if (typeof obj !== "object" || obj == null || obj == undefined)
            return obj; //primitive type

        let ret: any;
        let typeInfo: ILocalTypeInfo;

        if (obj._type) {

            if (obj._type === "Buffer") {
                let buf = this.binaryBufferList.get(obj.id);
                if (!buf) {
                    this.log.error(`PROTOCOL ERROR: Can't retrieve buffer with id ${obj.id}`);
                    return;
                }
                this.binaryBufferList.delete(obj.id);
                return buf;
            }

            typeInfo = this.typesByName.get(obj._type);
            if (typeInfo == undefined)
                throw {
                    message: "Unknown type",
                    typeName: obj._type
                };

            if (typeInfo.prototype) {
                if (obj._byRef !== undefined) {
                    let trackedObjInfo = this.tracklist.get(obj._byRef);
                    if (trackedObjInfo && trackedObjInfo.obj) {
                        //this is a tracked object. We want to update its content without creating a new
                        //Javascript object, so we strip all properties and let the block below copy the
                        //new values.

                        let trackedObj = trackedObjInfo.obj;
                        let keys = Object.keys(trackedObj);
                        keys.forEach(key => {
                            delete trackedObj[key];
                        });
                        ret = trackedObj;
                    }
                    else
                        ret = new typeInfo.prototype();

                    this.objecIds.set(ret, obj._byRef);
                }
                else
                    ret = new typeInfo.prototype();
            }
            else
                ret = {};
        }
        else
            ret = {};

        let keys = Object.keys(obj);
        keys.forEach(key => {
            if (key != "_byRef" && key != "_type")
                ret[key] = this.deserializeFast(obj[key]);
        });

        if (typeInfo && typeInfo.serializationInfo && typeInfo.serializationInfo.deserialize) {
            ret = typeInfo.serializationInfo.deserialize(ret);
        }

        return ret;

    }

    private async deserialize(obj: any): Promise<any> {

        try {
            return this.deserializeFast(obj);
        }
        catch (err) {
            if (err.typeName) {
                await this.getType(err.typeName);
                return this.deserialize(obj);
            }
        }
    }



    private async process_result(cmd: Protocol.IInvokeResultCommand) {

        let promiseInfo = this.calls.get(cmd.callId);
        if (!promiseInfo) {
            log.error(`call id ${cmd.callId} not found`);
            return;
        }

        this.calls.delete(cmd.callId);

        if (cmd.status == 0) {
            let result = await this.deserialize(cmd.result);
            promiseInfo.resolve(result);

        } else
            promiseInfo.reject(cmd.message);
    }

    private async process_event(cmd: Protocol.IEventFiredCommand) {

        let id = cmd.sourceObjectId;
        if (id == undefined)
            return;

        let objectInfo: IRemoteObjectInfo = this.tracklist.get(id);
        if (!objectInfo) {
            log.warn("Received event about untracked object id " + id);
            return;
        }

        let sourceObj = objectInfo.obj;
        let events: Map<string, Set<IHyperJumpEventHandler>>;
        let handlers: Set<IHyperJumpEventHandler>;
        let args = await this.deserialize(cmd.args);

        if (objectInfo && (events = objectInfo.events) && (handlers = events.get(cmd.eventName))) {
            handlers.forEach(async (handler) => {
                handler(sourceObj, ...args);
            })
        }
    }

    private async process_buffer(cmd: Protocol.IBinaryDataHeaderCommand) {
        if (this.nextBinaryDataHeaderCommand) {
            this.log.error("PROTOCOL ERROR: new binary data header received before receiving binary data");
            return;
        }

        this.nextBinaryDataHeaderCommand = cmd;
    }

    private generateProxyFunction(id: number) {
        let self = this;
        return function () {
            return self.invokeRemoteFunction(id, this, arguments);
        }
    }

    private getRef(obj: any): any {
        let id = this.objecIds.get(obj);
        if (id == undefined)
            return obj;
        else
            return { _byRef: id };
    }

    private idCall = 0;
    private invokeRemoteFunction(id: number, thisArg: any, args: IArguments = null) {
        thisArg = this.serialize(thisArg);
        let a: any[] = [];
        if (args) {
            for (var i = 0; i < args.length; i++) {
                a[i] = this.serialize(args[i]);
            }
        }
        this.idCall++;
        return new Promise<any>((resolve, reject) => {
            this.calls.set(this.idCall, { resolve, reject });
            let cmd: Protocol.IInvokeCommand = {
                command: "invoke",
                functionId: id,
                callId: this.idCall,
                thisArg: thisArg,
                args: a,
            }
            if (this.debugMode) {
                let functionName = this.debugMethodList.get(id);
                if (functionName === undefined)
                    functionName = "#" + id.toString();
                cmd.debugInfo = functionName;
            }
            this.send(cmd);

        });
    }

    private bufferId = 0;
    private send(data: any) {
        this.socket.send(JSON.stringify(data));
    }

    private sendBuffer(buf: ArrayBuffer) {
        let id = this.bufferId++;
        this.send({
            command: "buffer",
            id: id,
            length: buf.byteLength
        } as Protocol.IBinaryDataHeaderCommand);

        this.socket.send(buf);

        return id;
    }

    public track(obj: any): IRemoteObjectInfo {
        let id = this.objecIds.get(obj);
        if (id === undefined)
            throw new Error("Can't track unknown object");

        let objectInfo = this.tracklist.get(id);
        if (!objectInfo) {
            objectInfo = {
                events: null,
                obj: obj
            }
            this.tracklist.set(id, objectInfo);
        }
        return objectInfo;
    }

    public untrack(obj: any) {
        let id = this.objecIds.get(obj);
        if (id === undefined)
            throw new Error("Can't untrack unknown object");

        this.tracklist.delete(id);

    }

    public async listen(obj: any, eventName: string, listener: IHyperJumpEventHandler): Promise<void> {
        let objectInfo = this.track(obj);
        let events = objectInfo.events;
        if (!events) {
            events = objectInfo.events = new Map<string, Set<IHyperJumpEventHandler>>();
        }
        let handlers = events.get(eventName);
        if (!handlers) {
            events.set(eventName, handlers = new Set<IHyperJumpEventHandler>());

        }
        if (handlers.has(listener))
            return;

        handlers.add(listener);
        if (handlers.size == 1)
            return this.root_.listen(obj, eventName);
        else
            return;

    }

    public async unlisten(obj: any, eventName?: string, listener?: IHyperJumpEventHandler) {
        let id = this.objecIds.get(obj);
        if (id === undefined)
            return;

        let objectInfo = this.tracklist.get(id);
        if (!objectInfo)
            return;

        let events = objectInfo.events;
        if (!events) {
            return;
        }

        if (eventName === undefined) {
            for (let eventName of events.keys()) {
                this.root_.unlisten(obj, eventName);
            }
            events.clear();
            return;
        }

        let handlers = events.get(eventName);
        if (!handlers) {
            return;
        }

        if (listener === undefined) {
            handlers.clear();
        }
        else {
            if (!handlers.has(listener))
                return;

            handlers.delete(listener);
        }
        if (handlers.size == 0)
            return this.root_.unlisten(obj, eventName);
        else
            return;
    }

    public async refresh(obj: any) {
        if (!this.root_) {
            throw new Error("root not ready yet");
        }

        let id = this.objecIds.get(obj);
        if (id === undefined)
            throw new Error("can't refresh unknown object");

        return this.root_.getObject(id);
    }

}
