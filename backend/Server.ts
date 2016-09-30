import * as loglevel from "loglevel";
import * as events from "events";
import * as WebSocket from "ws";
import * as http from "http";
import * as Protocol from "./Protocol";

const parseFunction = require("parse-function");

var log = loglevel.getLogger("hyperjump-server");

export interface IObjectInfo {
    id: number,
    lastPing: number,
    obj: any,
    events: Map<string, Set<Agent>>;
}

export interface IContextInfo {
    agent: Agent
}



function createRootClass(server: HyperjumpServer): { new (): any } {

    class Root {

        public getType(typeName: string): Protocol.ITypeInfo {
            return server.getType(typeName);
        }
        public pingObjects(obj: any[]) {
        }

        public listen(obj: any, eventName: string) {
            return server.listen(obj, eventName);
        }

        public unlisten(obj: any, eventName: string) {
            return server.unlisten(obj, eventName);
        }
        public getObject(nameOrId: string | number) {

            if (typeof nameOrId === "number")
                return server.getObjectById(nameOrId);
            else
                return server.getObjectByName(nameOrId);
        }
    }
    return Root;
}



const GC_TIMER = 60 * 1000;
const GC_OBJECT_TIMEOUT = 5 * 60 * 1000;

export class HyperjumpServer extends events.EventEmitter {

    private objects: WeakMap<any, IObjectInfo>;
    private functions = new Map<number, Function>();
    private types: WeakMap<Function, Protocol.ITypeInfo>;
    private typesByName: Map<string, Protocol.ITypeInfo>;
    private objectIds: Map<number, IObjectInfo>;
    private objectsByName = new Map<string, any>();
    private objectCounter: number = 0;
    private agents: Map<number, Agent>;
    private root_: any;
    private currentContext_: IContextInfo = null;

    constructor(server: http.Server, path: string) {
        super();
        this.agents = new Map<number, Agent>();
        let wss = new WebSocket.Server({ server: server, path: path });
        let agentId = 0;
        this.types = new WeakMap<any, Protocol.ITypeInfo>();
        this.typesByName = new Map<string, Protocol.ITypeInfo>();
        this.objectIds = new Map<number, IObjectInfo>();

        wss.on("connection", (socket) => {
            let agent = new Agent(this, socket, agentId++);
            this.agents.set(agent.id, agent);

            socket.on("error", (err) => {
                this.removeAgent(agent);
            });

            socket.on("close", (code, message) => {
                this.removeAgent(agent);
            });

            this.emit("connection", agent);
        });

        wss.on("error", (error) => {
            this.emit("error", error);
        });


        this.objects = new WeakMap<Object, IObjectInfo>();

        let Root = createRootClass(this);
        this.root_ = new Root();


        this.registerType(Root, "Root"); //root is always alive.

        this.pin(this.root_); //id 0, keep forever
        this.registerMethod(Root, "getType"); // func 1. Protocol.ROOT_FUNCTION_GET_TYPE
        this.registerMethod(Root, "getObject"); // func 2. Protocol.ROOT_FUNCTION_GET_OBJECT
        this.registerMethod(Root, "pingObjects");
        this.registerMethod(Root, "listen");
        this.registerMethod(Root, "unlisten");


        this.registerTypeInfo(Date, Protocol.DateTypeInfo);


        setInterval(() => {
            this.gc();
        }, GC_TIMER);
    }

    public get root(): any {
        return this.root_;
    }
    public get currentContext() {
        return this.currentContext_;
    }

    public getType(typeName: string): Protocol.ITypeInfo {
        return this.typesByName.get(typeName);
    }

    public getObjectById(id: number) {
        let objInfo = this.objectIds.get(id);

        if (!objInfo)
            return null;

        let obj = objInfo.obj;
        if (!obj)
            return null;

        this.pingObject(obj);
        return obj;
    }

    public pingObject(obj: any) {
        this.getObjectInfo(obj);
    }

    public removeObject(obj: any) {
        let objectInfo = this.objects.get(obj);
        if (!objectInfo)
            return;

        this.objects.delete(obj);
        this.objectIds.delete(objectInfo.id);

    }

    public pin(obj: any) {
        this.getObjectInfo(obj).lastPing = -1;
    }

    private removeAgent(agent: Agent) {
        agent.terminate();
        this.objectIds.forEach(objInfo => {
            if (objInfo.events) {
                objInfo.events.forEach(event => {
                    event.delete(agent);
                })
            }
        })
        this.agents.delete(agent.id);
    }

    public getTypeInfo(obj: any): Protocol.ITypeInfo {
        if (obj == null || obj == undefined)
            return null;
        else
            return this.types.get(obj.constructor);
    }

    public getObjectInfo(obj: any): IObjectInfo {

        if (!this.getTypeInfo(obj)) {
            throw new Error("can't get object info from a non-object or unregistered type");
        }

        let objectInfo = this.objects.get(obj);
        if (objectInfo) {
            if (objectInfo.lastPing !== -1)
                objectInfo.lastPing = (new Date()).getTime();
            return objectInfo;
        }

        objectInfo = {
            id: this.objectCounter++,
            lastPing: (new Date()).getTime(),
            obj: obj,
            events: null
        }
        this.objects.set(obj, objectInfo);
        this.objectIds.set(objectInfo.id, objectInfo);

        return objectInfo;
    }

    public registerTypeInfo(type: Function, typeInfo: Protocol.ITypeInfo) {
        this.types.set(type, typeInfo);
        this.typesByName.set(typeInfo.name, typeInfo);
    }

    public registerType(type: Function, name?: string, referenceType: Protocol.RefType = Protocol.RefType.REFVALUE): Protocol.ITypeInfo {
        let typeInfo = this.types.get(type);
        if (typeInfo)
            throw new Error(`Type ${typeInfo.name} already registered`);

        typeInfo = {
            name: name || type.name,
            methods: {},
            clientMethods: {},
            referenceType: referenceType
        }

        this.registerTypeInfo(type, typeInfo);

        return typeInfo;
    }


    public registerMethodEx(type: Function, func: Function, name?: string) {
        if (!func)
            throw new Error("cant' register undefined function");
        let typeInfo = this.types.get(type);
        if (!typeInfo) {
            typeInfo = this.registerType(type);
        }
        typeInfo.methods[name || func.name] = this.registerFunction(func);
    }

    public registerMethod(type: Function, name: string) {
        this.registerMethodEx(type, type.prototype[name], name);
    }

    public registerClientMethodEx(type: Function, func: Function | string, name: string) {
        let parsed = parseFunction(func);
        let clientMethodInfo: Protocol.IFunctionDefinition = {
            args: parsed.args,
            body: parsed.body
        }
        let typeInfo = this.types.get(type);
        if (!typeInfo) {
            typeInfo = this.registerType(type);
        }
        typeInfo.clientMethods[name] = clientMethodInfo;
    }

    public registerClientMethod(type: Function, name: string) {
        this.registerClientMethodEx(type, type.prototype[name], name);
    }

    public registerFunction(func: Function): number {
        let id = this.objectCounter++;
        this.functions.set(id, func);

        return id;
    }

    public registerSerializer(type: Function, serializationInfo: Protocol.ISerializationInfo) {
        let typeInfo = this.types.get(type);
        if (!typeInfo)
            throw new Error("Can't set serializer to unregistered type");
        typeInfo.serializationInfo = serializationInfo;

        if (!serializationInfo.serializerDef)
            serializationInfo.serializerDef = parseFunction(serializationInfo.serialize);

        if (!serializationInfo.deserializerDef)
            serializationInfo.deserializerDef = parseFunction(serializationInfo.deserialize);

    }

    public registerObject(obj: any, name: string) {
        this.pin(obj);
        this.objectsByName.set(name, obj);
    }

    public createGenericType(name: string): { new (): any } {
        let type = function () { };
        this.registerType(type, name);
        return type as any;
    }

    public getObjectByRef(obj: any | Protocol.IByRef): any {

        if (obj._byRef != undefined) {
            let ret = this.getObjectById(obj._byRef);
            if (!ret)
                throw new Error(`Unknown reference to object with id ${obj._byRef}`);
            return ret;
        }

        return obj;
    }

    public getObjectByName(name: string): any {
        return this.objectsByName.get(name);
    }


    public invokeFunction(id: number, thisObj: any, agent: Agent, args: any[]) {
        return new Promise<any>((resolve, reject) => {
            let func = this.functions.get(id);
            if (!func) {
                reject(new Error(`can't find function with id ${id}`));
                return;
            }

            try {
                this.currentContext_ = { agent: agent };
                let retval = func.apply(thisObj, args);
                this.currentContext_ = null;
                Promise.resolve(retval).then((value) => {
                    resolve(value);
                });
            }
            catch (e) {
                reject(e);
            }

        });

    }
    public listen(obj: any, eventName: string) {
        let agent = this.currentContext_ && this.currentContext_.agent;
        if (!agent)
            throw new Error("no current context calling listen()");

        let objInfo = this.getObjectInfo(obj);
        if (!objInfo.events)
            objInfo.events = new Map<string, Set<Agent>>();
        let agents = objInfo.events.get(eventName);
        if (!agents)
            objInfo.events.set(eventName, agents = new Set<Agent>());
        agents.add(agent);
    }

    public unlisten(obj: any, eventName: string) {
        let agent = this.currentContext_ && this.currentContext_.agent;
        if (!agent)
            throw new Error("no current context calling unlisten()");

        let objInfo = this.getObjectInfo(obj);
        if (!objInfo.events)
            return;

        let agents = objInfo.events.get(eventName);
        if (!agents)
            return;

        agents.delete(agent);

    }

    public fireEvent(sourceObj: any, eventName: string, ...args: any[]) {
        let objInfo = this.getObjectInfo(sourceObj);
        if (objInfo.events) {
            let event = objInfo.events.get(eventName);
            if (event) {
                event.forEach(agent => {
                    agent.notifyEventFired(objInfo.id, eventName, args);
                });
            }
        }
    }

    public gc() {
        let now = (new Date()).getTime();
        for (let [id, objInfo] of this.objectIds) {
            if (objInfo.lastPing !== -1) {
                if (now - objInfo.lastPing > GC_OBJECT_TIMEOUT) {
                    this.objectIds.delete(id);
                    this.objects.delete(objInfo.obj);
                }
            }
        }
    }

    public getTypeByName(name: string): Protocol.ITypeInfo {
        return this.typesByName.get(name);
    }
}

interface IEventInfo {

}

export class Agent {

    private hjs: HyperjumpServer;
    private socket: WebSocket;
    public id: number;
    private eventSubscriptions = new WeakMap<any, Set<string>>();
    private binaryBufferList = new Map<number, Buffer>();
    private nextBinaryDataHeaderCommand: Protocol.IBinaryDataHeaderCommand;

    private socket_message: Function;

    constructor(hjs: HyperjumpServer, socket: WebSocket, id: number) {
        this.hjs = hjs;
        this.socket = socket;
        this.id = id;
        this.socket.on("message", this.socket_message = (data: any, flags: { binary: boolean }) => {
            if (!flags.binary)
                this.processMessage(JSON.parse(data));
            else {
                if (!this.nextBinaryDataHeaderCommand) {
                    console.error("HYPERJUMP PROTOCOL ERROR: Binary data received without header");
                    return;
                }
                let buf = data as Buffer;
                if (buf.byteLength != this.nextBinaryDataHeaderCommand.length) {
                    console.error("HYPERJUMP PROTOCOL ERROR: Binary data received length mismatch");
                    return;
                }
                //TODO: Limit how much data is pending in binaryBufferList
                this.binaryBufferList.set(this.nextBinaryDataHeaderCommand.id, buf);
                this.nextBinaryDataHeaderCommand = undefined;
            }
        })
    }

    public terminate() {

        this.socket.removeListener("message", this.socket_message);
    }


    private processMessage(cmd: Protocol.ICommand) {
        console.log(cmd);
        switch (cmd.command) {
            case "invoke": this.process_invoke(cmd as Protocol.IInvokeCommand); break;
            default: {
                log.warn("Unknown cmd type " + cmd.command);
            }
        }
    }

    private process_invoke(cmd: Protocol.IInvokeCommand) {

        let thisObj: any;
        let args: any[] = cmd.args;
        try {
            thisObj = this.deserialize(cmd.thisArg);
            if (typeof thisObj != "object" || !thisObj)
                throw new Error("thisArg is not an object");

            for (let i = 0; i < args.length; i++) {
                args[i] = this.deserialize(args[i]);
            }
        }
        catch (e) {
            let rcmd: Protocol.IInvokeResultCommand = {
                command: "result",
                callId: cmd.callId,
                result: null,
                status: 1,
                message: e
            }
            this.send(rcmd);
        }

        this.hjs.invokeFunction(cmd.functionId, thisObj, this, args).then(retVal => {
            let rcmd: Protocol.IInvokeResultCommand = {
                command: "result",
                callId: cmd.callId,
                result: this.serialize(retVal),
                status: 0,
                message: "OK"
            }
            this.send(rcmd);
        }).catch(err => {
            let rcmd: Protocol.IInvokeResultCommand = {
                command: "result",
                callId: cmd.callId,
                result: null,
                status: 1,
                message: err
            }
            this.send(rcmd);
        })
    }


    public serialize(obj: any): any {

        if (Array.isArray(obj)) {
            let arr: any[] = [];
            (obj as any[]).forEach(element => {
                arr.push(this.serialize(element));
            });
            return arr;
        }

        if (Buffer.isBuffer(obj)) {

            let id = this.sendBuffer(obj as Buffer);

            return {
                _type: "Buffer",
                id: id
            }
        }

        if (typeof obj !== "object" || obj == null || obj == undefined)
            return obj; //primitive type

        let type = this.hjs.getTypeInfo(obj);

        let originalObject = obj;

        if (type) {
            if (type.referenceType == Protocol.RefType.REFONLY)
                obj = {};
            else {
                if (type.serializationInfo && type.serializationInfo.serialize) {
                    obj = type.serializationInfo.serialize(obj);
                }
            }
        }

        let ret: any = {};
        let keys = Object.keys(obj);
        keys.forEach(key => {
            ret[key] = this.serialize(obj[key]);
        });


        if (type) {
            ret._type = type.name;
            if (type.referenceType == Protocol.RefType.REFVALUE || type.referenceType == Protocol.RefType.REFONLY) {
                let objInfo = this.hjs.getObjectInfo(originalObject);
                ret._byRef = objInfo.id;
            }
        }

        return ret;

    }

    public deserialize(obj: any): any {

        if (Array.isArray(obj)) {
            let arr: any[] = [];
            (obj as any[]).forEach(element => {
                arr.push(this.deserialize(element));
            });
            return arr;
        }

        if (typeof obj !== "object" || obj == null || obj == undefined)
            return obj; //primitive type

        if ((obj as Protocol.IByRef)._byRef !== undefined) {
            return this.hjs.getObjectByRef(obj);
        }

        let ret: any = {};

        let keys = Object.keys(obj);
        keys.forEach(key => {
            if (key != "_type")
                ret[key] = this.deserialize(obj[key]);
        });

        let type: Protocol.ITypeInfo;
        if (obj._type && (type = this.hjs.getTypeByName(obj._type)) && (type.referenceType == Protocol.RefType.REFVALUE) &&
            type.serializationInfo && type.serializationInfo.deserialize) {

            ret = type.serializationInfo.deserialize(ret);
        }

        return ret;

    }

    private bufferId = 0;
    private send(data: any) {
        this.socket.send(JSON.stringify(data));
    }

    private sendBuffer(buf: Buffer) {
        let id = this.bufferId++;
        this.send({
            command: "buffer",
            id: id,
            length: buf.byteLength
        } as Protocol.IBinaryDataHeaderCommand);

        this.socket.send(buf, { binary: true });

        return id;
    }

    public notifyEventFired(sourceObjectId: number, eventName: string, args: any[]) {
        this.send({
            command: "event",
            eventName: eventName,
            args: this.serialize(args),
            sourceObjectId: sourceObjectId
        } as Protocol.IEventFiredCommand)
    }

}
