import * as loglevel from "loglevel";
import * as events from "events";
import * as WebSocket from "ws";
import * as http from "http";
import * as Protocol from "./Protocol";

const parseFunction = require("parse-function");

var log = loglevel.getLogger("modelsync-server");

interface IObjectMetadata {
    id: number,
    lastPing: number,
    obj: any,
    events: Map<string, Set<Agent>>;
}

export interface IContextInfo {
    agent: Agent
}



function createRootClass(server: SyncServer): { new (): any } {

    class Root {

        public getType(typeName: string): Protocol.ITypeInfo {
            return server.getType(typeName);
        }
        public getObject(id: number) {
            return server.getObject(id);
        }
        public pingObjects(obj: any[]) {
        }

        public listen(obj: any, eventName: string) {
            return server.listen(obj, eventName);
        }

        public unlisten(obj: any, eventName: string) {
            return server.unlisten(obj, eventName);
        }
    }
    return Root;
}



const GC_TIMER = 60 * 1000;
const GC_OBJECT_TIMEOUT = 5 * 60 * 1000;

export class SyncServer extends events.EventEmitter {

    private objects: WeakMap<any, IObjectMetadata>;
    private functions = new Map<number, Function>();
    private types: WeakMap<Function, Protocol.ITypeInfo>;
    public typesByName: Map<string, Protocol.ITypeInfo>;
    private objectIds: Map<number, IObjectMetadata>;
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
        this.objectIds = new Map<number, IObjectMetadata>();

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


        this.objects = new WeakMap<Object, IObjectMetadata>();

        let Root = createRootClass(this);
        this.root_ = new Root();

        this.registerType(Root, "Root");
        this.pin(this.root_); //id 0, keep forever
        this.registerMethod(Root, "getType"); // func 1.
        this.registerMethod(Root, "getObject"); // func 2.
        this.registerMethod(Root, "pingObjects");
        this.registerMethod(Root, "listen");
        this.registerMethod(Root, "unlisten");

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

    public getObject(id: number) {
        let obj = this.objectIds.get(id).obj;
        if (!obj)
            return null;

        this.pingObject(obj);
        return obj;
    }
    public pingObject(obj: any) {
        this.getMetadata(obj);
    }

    public pin(obj: any) {
        this.getMetadata(obj).lastPing = -1;
    }

    private removeAgent(agent: Agent) {
        agent.terminate();
        this.objectIds.forEach(meta => {
            if (meta.events) {
                meta.events.forEach(event => {
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

    private getMetadata(obj: any): IObjectMetadata {

        if (!this.getTypeInfo(obj)) {
            throw new Error("can't get metadata from a non-object or unregistered type");
        }

        let metadata = this.objects.get(obj);
        if (metadata) {
            if (metadata.lastPing !== -1)
                metadata.lastPing = (new Date()).getTime();
            return metadata;
        }

        metadata = {
            id: this.objectCounter++,
            lastPing: (new Date()).getTime(),
            obj: obj,
            events: null
        }
        this.objects.set(obj, metadata);
        this.objectIds.set(metadata.id, metadata);

        return metadata;
    }

    public registerType(type: Function, name?: string): Protocol.ITypeInfo {
        let typeInfo = this.types.get(type);
        if (typeInfo)
            throw new Error(`Type ${typeInfo.name} already registered`);

        typeInfo = {
            name: name || type.name,
            methods: {},
            clientMethods: {}

        }
        this.types.set(type, typeInfo);
        this.typesByName.set(typeInfo.name, typeInfo);
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

    public createGenericType(name: string): { new (): any } {
        let type = function () { };
        this.registerType(type, name);
        return type as any;
    }

    public serialize(obj: any): any {

        if (Array.isArray(obj)) {
            let arr: any[] = [];
            (obj as any[]).forEach(element => {
                arr.push(this.serialize(element));
            });
            return arr;
        }

        if (typeof obj !== "object" || obj == null || obj == undefined)
            return obj; //primitive type

        let type = this.getTypeInfo(obj);
        if (type && type.serializationInfo && type.serializationInfo.serialize) {
            obj = type.serializationInfo.serialize(obj);
        }

        let ret: any = {};

        let keys = Object.keys(obj);
        keys.forEach(key => {
            ret[key] = this.serialize(obj[key]);
        });

        if (type) {
            let metadata = this.getMetadata(obj);
            ret._type = type.name;
            ret._byRef = metadata.id;

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
            return this.getObjectByRef(obj);
        }

        let ret: any = {};

        let keys = Object.keys(obj);
        keys.forEach(key => {
            ret[key] = this.deserialize(obj[key]);
        });

        return ret;

    }

    public getObjectByRef(obj: any | Protocol.IByRef): any {

        if (obj._byRef != undefined) {
            let ret = this.getObject(obj._byRef);
            if (!ret)
                throw new Error(`Unknown reference to object with id ${obj._byRef}`);
            return ret;
        }

        return obj;
    }


    public invokeFunction(id: number, thisArg: any, agent: Agent, args: any[]) {
        return new Promise<any>((resolve, reject) => {
            let func = this.functions.get(id);
            if (!func) {
                reject(new Error(`can't find function with id ${id}`));
                return;
            }
            let thisObj: any;
            try {
                thisObj = this.deserialize(thisArg);
                if (typeof thisObj != "object" || !thisObj)
                    throw new Error("thisArg is not an object");
            }
            catch (e) {
                reject(e);
            }

            try {
                for (let i = 0; i < args.length; i++) {
                    args[i] = this.deserialize(args[i]);
                }
            }
            catch (e) {
                reject(e);
            }

            try {
                this.currentContext_ = { agent: agent };
                let retval = func.apply(thisObj, args);
                this.currentContext_ = null;
                Promise.resolve(retval).then((value) => {
                    resolve(this.serialize(value));
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

        let meta = this.getMetadata(obj);
        if (!meta.events)
            meta.events = new Map<string, Set<Agent>>();
        let agents = meta.events.get(eventName);
        if (!agents)
            meta.events.set(eventName, agents = new Set<Agent>());
        agents.add(agent);
    }

    public unlisten(obj: any, eventName: string) {
        let agent = this.currentContext_ && this.currentContext_.agent;
        if (!agent)
            throw new Error("no current context calling unlisten()");

        let meta = this.getMetadata(obj);
        if (!meta.events)
            return;

        let agents = meta.events.get(eventName);
        if (!agents)
            return;

        agents.delete(agent);

    }

    public fireEvent(sourceObj: any, eventName: string, ...args: any[]) {
        let meta = this.getMetadata(sourceObj);
        if (meta.events) {
            let event = meta.events.get(eventName);
            if (event) {
                event.forEach(agent => {
                    agent.notifyEventFired(meta.id, eventName, this.serialize(args));
                });
            }
        }
    }

    public gc() {
        let now = (new Date()).getTime();
        for (let [id, meta] of this.objectIds) {
            if (meta.lastPing !== -1) {
                if (now - meta.lastPing > GC_OBJECT_TIMEOUT) {
                    this.objectIds.delete(id);
                }
            }
        }
    }
}

interface IEventInfo {

}

export class Agent {

    private om: SyncServer;
    private socket: WebSocket;
    private sentObjects = new WeakSet();
    public id: number;
    private eventSubscriptions = new WeakMap<any, Set<string>>();

    private socket_message: Function;

    constructor(om: SyncServer, socket: WebSocket, id: number) {
        this.om = om;
        this.socket = socket;
        this.id = id;
        this.socket.on("message", this.socket_message = (data: any, flags: any) => {
            this.processMessage(JSON.parse(data));
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
        this.om.invokeFunction(cmd.functionId, cmd.thisArg, this, cmd.args).then(retVal => {
            let rcmd: Protocol.IInvokeResultCommand = {
                command: "result",
                callId: cmd.callId,
                result: retVal,
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

    private send(data: any) {
        this.socket.send(JSON.stringify(data));
    }

    public notifyEventFired(sourceObjectId: number, eventName: string, args: any[]) {
        this.send({
            command: "event",
            eventName: eventName,
            args: args,
            sourceObjectId:sourceObjectId
        } as Protocol.IEventFiredCommand)
    }

}
