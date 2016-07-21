import "./utils/loglevelInit";
import * as loglevel from "loglevel";
import * as events from "events";
import * as WebSocket from "ws";
import * as http from "http";
import * as Protocol from "./Protocol";

var log = loglevel.getLogger("modelsync-server");

export interface IObjectMetadata {
    proxy: any,
    originalObject: any,
    id: number
}


class RootObject { };

const GC_TIMER = 60 * 1000;



export class SyncServer extends events.EventEmitter {

    private objects: WeakMap<any, IObjectMetadata>;
    private proxies: WeakMap<any, any>;
    private functions = new Map<number, Function>();
    private types: WeakMap<Function, Protocol.ITypeInfo>;
    public typesByName: Map<string, Protocol.ITypeInfo>;
    private objectIds: Map<number, any>;
    private objectCounter: number = 0;
    private agents: Map<number, Agent>;

    private root_: RootObject;

    constructor(server: http.Server, path: string) {
        super();
        this.agents = new Map<number, Agent>();
        this.proxies = new WeakMap<any, any>();
        let wss = new WebSocket.Server({ server: server, path: path });
        let agentId = 0;
        this.root_ = new RootObject;
        this.types = new WeakMap<any, Protocol.ITypeInfo>();
        this.typesByName = new Map<string, Protocol.ITypeInfo>();
        this.objectIds = new Map<number, any>();

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
        this.registerType(Array, "Array");
        this.registerType(RootObject, "Root");
        this.getProxy(this.root_);
        this.scheduleGC();
    }

    private removeAgent(agent: Agent) {
        agent.terminate();
        this.agents.delete(agent.id);
    }

    public isRegisteredType(obj: any): boolean {
        return obj != null && obj != undefined && this.types.has(obj.constructor);
    }

    private proxyHandler = {
        get: (target: any, property: PropertyKey) => {
            let value = target[property];
            if (typeof value == "object") {
                return this.getProxy(value);
            }
            else
                return value;
        },
        set: (target: any, property: PropertyKey, value: any, receiver: any): boolean => {

            if (typeof value == "object" && value != null && value != undefined) {
                let original = this.proxies.get(value);
                if (original)
                    value = original;
            }

            target[property] = value;
            this.emit("set", target, property, value);
            return true;
        },

        deleteProperty: (target: any, property: PropertyKey): boolean => {
            delete target[property];
            this.emit("delete", target, property);
            return true;
        }
    };


    public get root(): any {
        return this.root_;
    }

    public getProxy<T>(obj: T): T {

        return this.getMetadata(obj).proxy;
    }
    public getMetadata<T>(obj: T): IObjectMetadata {

        if (!this.isRegisteredType(obj)) {
            throw new Error("can't get a proxy from a non-object or unregistered type");
        }
        //check if a proxy was passed instead of an original object.
        let original = this.proxies.get(obj);
        if (original) {
            obj = original as T;
        }

        let self = this;
        let metadata = this.objects.get(obj);
        if (metadata)
            return metadata;

        let pr = new Proxy(obj, this.proxyHandler);
        this.proxies.set(pr, obj);

        metadata = {
            proxy: pr,
            originalObject: obj,
            id: this.objectCounter++
        }
        this.objects.set(obj, metadata);
        this.objectIds.set(metadata.id, obj);
        this.emit("new", metadata);


        return metadata;
    }

    public registerType(type: Function, name?: string): Protocol.ITypeInfo {
        let typeInfo = this.types.get(type);
        if (typeInfo)
            throw new Error(`Type ${typeInfo.name} already registered`);

        typeInfo = {
            name: name || type.name,
            methods: {}

        }
        this.types.set(type, typeInfo);
        this.typesByName.set(typeInfo.name, typeInfo);
        this.emit("newType", typeInfo);
        return typeInfo;
    }

    public registerMethod(type: Function, func: Function, name?: string) {
        let typeInfo = this.types.get(type);
        if (!typeInfo) {
            typeInfo = this.registerType(type);
        }
        typeInfo.methods[name || func.name] = this.registerFunction(func);
    }

    public registerFunction(func: Function): number {
        let id = this.objectCounter++;
        this.functions.set(id, func);

        return id;

    }

    private getRef(obj: any): Protocol.IByRef {
        let id = this.getMetadata(obj).id;
        let construct = this.types.get(obj.constructor);
        if (construct)
            return { _byref: id, _construct: construct };
        else
            return { _byref: id };
    }

    private scheduleGC() {
        this.gc();
        let aliveIds = this.getAliveIds();
        this.agents.forEach((agent) => {
            agent.alive(aliveIds);
        });
        setTimeout(() => {
            this.scheduleGC();
        }, GC_TIMER);
    }

    public serialize(obj: any): any {

        if (!this.isRegisteredType(obj))
            return obj;

        let ret = {};

        if (Array.isArray(obj)) {
            ret["_type"] = "array";

        }
        else {
            let type = this.types.get(obj.constructor);
            if (type)
                ret["_type"] = type.name;
        }

        let keys = Object.keys(obj);
        keys.forEach(key => {
            let value = obj[key];

            if (this.isRegisteredType(value)) {
                ret[key] = this.getRef(value);
            } else {
                ret[key] = value;
            }

        });

        return ret;

    }

    public getAliveIds(): number[] {
        return [...this.objectIds.keys()];
    }

    public gc(obj: any = null) {

        if (obj == null) {
            obj = this.root;
            this.objectIds.clear();
        }

        let id = this.getMetadata(obj).id;
        if (this.objectIds.has(id))
            return;

        this.objectIds.set(id, obj);

        let keys = Object.keys(obj);
        keys.forEach((key) => {
            let value = obj[key];
            if (this.isRegisteredType(value)) {
                this.gc(value);
            }
        });
    }


    public checkByRef(obj: any | Protocol.IByRef): any {

        if (obj._byref != undefined) {
            let ret = this.objectIds.get(obj._byref);
            if (!ret)
                throw new Error(`Unknown reference to object with id ${obj._byref}`);
            return ret;
        }
        return obj;
    }

    public invokeFunction(id: number, thisArg: number, args: any[]) {
        return new Promise<any>((resolve, reject) => {
            let func = this.functions.get(id);
            if (!func) {
                reject(new Error(`can't find function with id ${id}`));
                return;
            }
            let thisObj: any;
            try {
                thisObj = this.checkByRef(thisArg);
            }
            catch (e) {
                reject(e);
            }

            try {
                for (let i = 0; i < args.length; i++) {
                    let arg = args[i];
                    if (typeof arg == "object") {
                        args[i] = this.checkByRef(arg);
                    }
                }
            }
            catch (e) {
                reject(e);
            }

            try {
                let retval = func.apply(thisObj, args);
                Promise.resolve(retval).then((value) => {
                    resolve(value);
                });
            }
            catch (e) {
                reject(e);
            }

        });

    }
}


class Agent {

    private om: SyncServer;
    private socket: WebSocket;
    private sentObjects = new WeakSet();
    public id: number;

    private om_new: Function;
    private om_set: Function;
    private om_newType: Function;
    private om_delete: Function;
    private socket_message: Function;

    constructor(om: SyncServer, socket: WebSocket, id: number) {
        this.om = om;
        this.socket = socket;
        this.id = id;
        this.initialSync();

        om.on("new", this.om_new = (meta: IObjectMetadata) => {
            this.notifyNew(meta.originalObject);
        });

        om.on("set", this.om_set = (target: any, property: PropertyKey, value: any) => {
            this.notifySet(target, property, value);
        });

        om.on("newType", this.om_newType = (typeInfo: Protocol.ITypeInfo) => {
            this.notifyNewType(typeInfo);
        })

        om.on("delete", this.om_delete = (target: any, property: PropertyKey) => {
            this.notifyDelete(target, property);
        });

        this.socket.on("message", this.socket_message = (data:any, flags:any) => {
            this.processMessage(JSON.parse(data));
        })
    }

    public terminate() {
        this.om.removeListener("new",this.om_new);
        this.om.removeListener("set",this.om_set);
        this.om.removeListener("newType",this.om_newType);
        this.om.removeListener("delete",this.om_delete);
        this.socket.removeListener("message",this.socket_message);
    }

    private serialize(obj: any) {
        this.notifyNew(obj);
        return this.om.serialize(obj);
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
        this.om.invokeFunction(cmd.functionId, cmd.thisArg, cmd.args).then(retVal => {
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

    private initialSync() {

        this.syncTypes();
        this.syncObject(this.om.root);
    }

    private syncObject(obj: any) {
        let keys = Object.keys(obj);
        keys.forEach(key => {
            let value = obj[key];
            if (typeof value == "object" && value != null && value != undefined) {
                this.syncObject(value);
            }

        });

        this.notifyNew(obj);
    }

    private syncTypes() {
        for (let value of this.om.typesByName.values()) {
            this.notifyNewType(value);
        }
    }

    private send(data: any) {
        this.socket.send(JSON.stringify(data));
    }

    private notifyNew(obj: any) {
        if (!this.om.isRegisteredType(obj) || this.sentObjects.has(obj))
            return;

        this.sentObjects.add(obj);
        this.send({
            command: "new",
            objectId: this.om.getMetadata(obj).id,
            newObj: this.serialize(obj)
        } as Protocol.INewObjectCommand);
    }

    private notifySet(obj: any, property: PropertyKey, newValue: any) {
        if (typeof newValue == "object" && newValue != null && newValue != undefined) {
            newValue = { _byref: this.om.getMetadata(newValue).id };
        }
        else {
            newValue = this.serialize(newValue);
        }
        this.send({
            command: "set",
            objectId: this.om.getMetadata(obj).id,
            property: property,
            value: newValue

        } as Protocol.ISetPropertyCommand)
    }

    private notifyNewType(typeInfo: Protocol.ITypeInfo) {

        this.send({
            command: "newType",
            typeInfo: typeInfo
        } as Protocol.INewTypeCommand);
    }

    private notifyDelete(target: any, property: PropertyKey) {
        this.send({
            command: "delete",
            objectId: this.om.getMetadata(target).id,
            property: property
        })
    }

    public alive(aliveIds: number[]) {
        this.send({
            command: "alive",
            aliveIds
        } as Protocol.IKeepAliveCommand);
    }

}
