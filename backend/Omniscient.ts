/// <reference path="../typings/tsd.d.ts" />

import "./utils/loglevelInit";

import * as loglevel from "loglevel";
import * as events from "events";
import * as WebSocket from "ws";
import * as http from "http";

var log = loglevel.getLogger("OMNISCIENT");

export interface IObjectMetadata {
    proxy: any,
    originalObject: any,
    id: number
}

export interface ITypeInfo {
    name: string,
    methods: { [methodName: string]: number }
}

export interface IByRef {
    _construct?: ITypeInfo,
    _byref: number
}

export class Omniscient extends events.EventEmitter {

    private objects: WeakMap<any, IObjectMetadata>;
    private proxies: WeakMap<any, any>;
    private functions = new Map<number, Function>();
    private types: WeakMap<Function, ITypeInfo>;
    public typeNames: Map<string, ITypeInfo>;
    private objectIds: Map<number, any>;
    private objectCounter: number = 0;
    private agents: Map<number, Agent>;

    private root_: any;

    constructor(server: http.Server) {
        super();
        this.agents = new Map<number, Agent>();
        this.proxies = new WeakMap<any, any>();
        let wss = new WebSocket.Server({ server: server });
        let agentId = 0;
        this.root_ = {};
        this.types = new WeakMap<any, ITypeInfo>();
        this.typeNames = new Map<string, ITypeInfo>();
        this.objectIds = new Map<number, any>();

        wss.on("connection", (socket) => {
            let agent = new Agent(this, socket, agentId++);

            socket.on("error", (err) => {
                this.clean(agent);
            });

            socket.on("close", (code, message) => {
                this.clean(agent);
            });

            this.emit("connection", agent);
        });


        this.objects = new WeakMap<Object, IObjectMetadata>();
        this.getProxy(this.root_);
    }

    private clean(agent: Agent) {
        this.agents.delete(agent.id);
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

            if (typeof value == "object") {
                let original = this.proxies.get(value);
                if (original)
                    value = original;
            }

            target[property] = value;
            this.emit("set", target, property, value);
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

        if (typeof obj != "object") {
            throw new Error("can't get a proxy from a non-object");
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

    public registerType(type: Function, name?: string): ITypeInfo {
        let typeInfo = this.types.get(type);
        if (typeInfo)
            throw new Error(`Type ${typeInfo.name} already registered`);

        typeInfo = {
            name: name || type.name,
            methods: {}

        }
        this.types.set(type, typeInfo);
        this.typeNames.set(typeInfo.name, typeInfo);
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

    private getRef(obj: any): IByRef {
        let id = this.getMetadata(obj).id;
        let construct = this.types.get(obj.constructor);
        if (construct)
            return { _byref: id, _construct: construct };
        else
            return { _byref: id };
    }

    public serialize(obj: any): any {

        if (typeof obj !== "object")
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

            if (typeof value == "object") {
                ret[key] = this.getRef(value);
            } else if (typeof value == "function") {
                ret[key] = { "_type": "function" };
            } else {
                ret[key] = value;
            }

        });

        return ret;

    }

    public getAliveIds(): string[] {
        return Object.keys(this.objectIds);
    }

    public gc(obj: any = null) {

        if (obj == null) {
            obj = this.root;
            this.objectIds.clear();
        }

        let id = this.getMetadata(obj).id;
        if (this.objectIds.has(id))
            return;

        let keys = Object.keys(obj);
        keys.forEach((key) => {
            let value = obj[key];
            if (typeof value == "object") {
                this.gc(value);
            }
        });
    }

    public checkByRef(obj: any | IByRef): any {

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

export interface ICommand {
    command: string,
}

export interface INewObjectCommand extends ICommand {
    newObj: any,
    objectId: number
}

export interface IInvokeCommand extends ICommand {
    functionId: number,
    callId: number,
    thisArg: number,
    args: any[]

}

export interface IInvokeResultCommand extends ICommand {
    callId: number,
    result: any,
    status: number,
    message?: string
}

export interface ISetPropertyCommand extends ICommand {
    objectId: number,
    property: string,
    value: any
}

export interface INewTypeCommand extends ICommand {
    typeInfo: ITypeInfo
}

class Agent {

    private om: Omniscient;
    private socket: WebSocket;
    private sentObjects = new WeakSet();
    public id: number;

    constructor(om: Omniscient, socket: WebSocket, id: number) {
        this.om = om;
        this.socket = socket;
        this.id = id;
        this.initialSync();

        om.on("new", (meta: IObjectMetadata) => {
            this.notifyNew(meta.originalObject);

        });

        om.on("set", (target: any, property: PropertyKey, value: any) => {
            this.notifySet(target, property, value);
        });

        this.socket.on("message", (data, flags) => {
            this.processMessage(JSON.parse(data));
        })
    }

    private serialize(obj: any) {
        this.notifyNew(obj);
        return this.om.serialize(obj);
    }

    private processMessage(cmd: ICommand) {
        console.log(cmd);
        switch (cmd.command) {
            case "invoke": this.process_invoke(cmd as IInvokeCommand); break;
            default: {
                log.warn("Unknown cmd type " + cmd.command);
            }
        }
    }

    private process_invoke(cmd: IInvokeCommand) {
        this.om.invokeFunction(cmd.functionId, cmd.thisArg, cmd.args).then(retVal => {
            let rcmd: IInvokeResultCommand = {
                command: "result",
                callId: cmd.callId,
                result: this.serialize(retVal),
                status: 0,
                message: "OK"

            }
            this.socket.send(JSON.stringify(rcmd));
        }).catch(err => {
            let rcmd: IInvokeResultCommand = {
                command: "result",
                callId: cmd.callId,
                result: null,
                status: 1,
                message: err
            }
            this.socket.send(JSON.stringify(rcmd));
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
            if (typeof value == "object") {
                this.syncObject(value);
            }

        });

        this.notifyNew(obj);
    }

    private syncTypes() {
        for (let value of this.om.typeNames.values()) {
            this.notifyNewType(value);
        }
    }

    private send(data: any) {
        this.socket.send(JSON.stringify(data));
    }

    private notifyNew(obj: any) {
        if (this.sentObjects.has(obj))
            return;

        this.sentObjects.add(obj);
        this.send({
            command: "new",
            objectId: this.om.getMetadata(obj).id,
            newObj: this.serialize(obj)
        } as INewObjectCommand);
    }

    private notifySet(obj: any, property: PropertyKey, newValue: any) {
        if (typeof newValue == "object") {
            newValue = { id: this.om.getMetadata(newValue).id };
        }
        else {
            newValue = this.serialize(newValue);
        }
        this.send({
            command: "set",
            objectId: this.om.getMetadata(obj).id,
            property: property,
            value: newValue

        } as ISetPropertyCommand)
    }

    private notifyNewType(typeInfo: ITypeInfo) {

        this.send({
            command: "newType",
            typeInfo: typeInfo
        } as INewTypeCommand);
    }

}
