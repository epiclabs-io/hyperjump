
import * as Protocol from "./Protocol";
import {EventEmitter} from "./EventEmitter";

var log = {
    log: function (type: string, st: string) {
        console.log(`modelsync-client [${type}]: ${st}`);
    },
    info: function (st: string) {
        this.log("INFO", st);
    },
    warn: function (st: string) {
        this.log("WARN", st);
    },
    error: function (st: string) {
        this.log("ERROR", st);
    },
}

interface ILocalTypeInfo extends Protocol.ITypeInfo {
    prototype: { new (): any };
}

interface IPromiseInfo {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
}

export interface IRemoteObjectInfo {
    events: Map<string, Set<Function>>;
}

const PING_OBJECTS_PERIOD = 60 * 1000;

export class SyncClient extends EventEmitter {

    private socket: WebSocket;
    public root: any;
    private objecIds = new WeakMap<any, number>();
    private typesByName = new Map<string, ILocalTypeInfo>();
    private types = new WeakMap<Function, ILocalTypeInfo>();
    private calls = new Map<number, IPromiseInfo>();
    private tracklist = new Map<number, IRemoteObjectInfo>();

    constructor(socket: any) {
        super();
        this.socket = socket;

        this.socket.onopen = async () => {
            console.log("socket open");
            let root = { _byRef: 0 };
            this.root = await this.invokeRemoteFunction(2, root, [0] as any)
            this.emit("root");

            this.schedulePing();

        };

        this.socket.onmessage = (event) => {
            this.processMessage(JSON.parse(event.data));
        };

        this.socket.onerror = (ev) => {
            log.error(ev.toString());
        }
        
        this.types.set(Date, Protocol.DateTypeInfo as ILocalTypeInfo);
        this.typesByName.set("Date", Protocol.DateTypeInfo as ILocalTypeInfo);

    }

    private schedulePing() {
        setInterval(() => {
            this.root.pingObjects([...this.tracklist.keys()]);

        }, PING_OBJECTS_PERIOD);
    }


    private processMessage(cmd: Protocol.ICommand) {
        console.log(cmd);
        switch (cmd.command) {
            case "result": this.process_result(cmd as Protocol.IInvokeResultCommand); break;
            case "event": this.process_event(cmd as Protocol.IEventFiredCommand); break;
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
        Proto["_type"] = typeInfo.name;

        for (var methodName of Object.keys(typeInfo.methods)) {
            Proto.prototype[methodName] = this.generateProxyFunction(typeInfo.methods[methodName]);
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
                functionId: 1, //getType
                callId: this.idCall,
                thisArg: { _byRef: 0 }, //Root
                args: [typeName],
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
            typeInfo = this.typesByName.get(obj._type);
            if (typeInfo == undefined)
                throw {
                    message: "Unknown type",
                    typeName: obj._type
                };

            if (obj._byRef !== undefined) {
                ret = new typeInfo.prototype();
                this.objecIds.set(ret, obj._byRef);
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
        let events: Map<string, Set<Function>>;
        let handlers: Set<Function>;
        if (objectInfo && (events = objectInfo.events) && (handlers = events.get(cmd.eventName))) {
            handlers.forEach(async (handler) => {
                handler.apply(null, await this.deserialize(cmd.args));
            })
        }
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
            this.send(cmd);

        });
    }

    private send(data: any) {
        this.socket.send(JSON.stringify(data));
    }

    public track(obj: any): IRemoteObjectInfo {
        let id = this.objecIds.get(obj);
        if (id === undefined)
            throw new Error("Can't track unknown object");

        let objectInfo = this.tracklist.get(id);
        if (!objectInfo) {
            objectInfo = {
                events: null
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

    public async listen(obj: any, eventName: string, listener: Function): Promise<void> {
        let objectInfo = this.track(obj);
        let events = objectInfo.events;
        if (!events) {
            events = objectInfo.events = new Map<string, Set<Function>>();
        }
        let handlers = events.get(eventName);
        if (!handlers) {
            events.set(eventName, handlers = new Set<Function>());

        }
        if (handlers.has(listener))
            return;

        handlers.add(listener);
        if (handlers.size == 1)
            return this.root.listen(obj, eventName);
        else
            return;

    }

    public async unlisten(obj: any, eventName: string, listener: Function) {
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
        let handlers = events.get(eventName);
        if (!handlers) {
            return;
        }
        if (!handlers.has(listener))
            return;

        handlers.delete(listener);

        if (handlers.size == 0)
            return this.root.unlisten(obj, eventName);
        else
            return;
    }

}
