/// <reference path="../typings/tsd.d.ts" />

import "./utils/loglevelInit";

import * as fs from "fs";
import * as path from "path";
import * as yargs from "yargs";
import * as loglevel from "loglevel";
import * as events from "events";
import * as WebSocket from "ws";
import * as express from "express";
import * as bodyParser from "body-parser";
import * as errorHandler from "errorhandler";
import * as methodOverride from "method-override";
import * as http from "http";

var log = loglevel.getLogger("MAIN");

class Being {
    private soul: string;

    constructor(soul: string) {
        this.soul = soul;
    }
}

class Person extends Being {
    age: number;
    name: string;

    constructor(name: string, age: number) {
        super(`${name}'s soul'`);
        this.name = name;
        this.age = age;
    }

    public greet(): string {
        return "Hello, " + this.name;
    }
}


class Thing {

    public color: string;
    public size: number;
    public owner: Person;

    constructor(color: string, size: number, owner: Person) {
        this.size = size;
        this.color = color;
        this.owner = owner;
    }

    public speak(greeting: string) {
        console.log(`${greeting}, my color is ${this.color}`);
    }



}


class Handler implements ProxyHandler<Thing>{

    private target: Thing;
    constructor(target: Thing) {
        this.target = target;
    }
    public get(i: Thing, name: string) {
        console.log(this);
        console.log(i, name);
        return i[name];
    }

}

interface IObjectMetadata {
    proxy: any,
    originalObject: any,
    id: number
}

interface ITypeMetadata {
    name: string,
    methods: Map<string, Function>
}


class Omniscient extends events.EventEmitter {

    private objects: WeakMap<any, IObjectMetadata>;
    private proxies: WeakMap<any, any>;
    private types: WeakMap<any, ITypeMetadata>;
    public typeNames: Map<string, ITypeMetadata>;
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
        this.types = new WeakMap<any, ITypeMetadata>();
        this.typeNames = new Map<string, ITypeMetadata>();
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

    public registerType(type: { new () }, name?: string): ITypeMetadata {
        let typeInfo = this.types.get(type);
        if (typeInfo)
            throw new Error(`Type ${typeInfo.name} already registered`);

        typeInfo = {
            name: name || type.name,
            methods: new Map<string, Function>()
        }
        this.types.set(type, typeInfo);
        this.typeNames.set(typeInfo.name, typeInfo);
        this.emit("newType", typeInfo);
        return typeInfo;
    }

    public registerMethod(type: { new () }, func: Function, name?: string) {
        let typeInfo = this.types.get(type);
        if (!typeInfo) {
            typeInfo = this.registerType(type);
        }
        typeInfo.methods.set(name || func.name, func);
    }

    public serialize(obj: any): any {

        if (typeof obj !== "object")
            return obj;

        let ret = {};

        if (Array.isArray(obj)) {
            ret["_type"] = "array";

        }

        let keys = Object.keys(obj);
        keys.forEach(key => {
            let value = obj[key];

            if (typeof value == "object") {
                ret[key] = { id: this.getMetadata(value).id };
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

    }

    private initialSync() {
        
        this.syncTypes();
        this.syncObject(this.om.root);
    }

    private syncObject(obj:any){
        let keys = Object.keys(obj);
        keys.forEach(key => {
            let value = obj[key];
            if (typeof value == "object") {
                this.syncObject(value);
            }

        });

        this.notifyNew(obj);
    }

    private syncTypes(){
        for(let value of this.om.typeNames.values()){
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
            id: this.om.getMetadata(obj).id,
            data: this.om.serialize(obj)
        });
    }

    private notifySet(obj: any, property: PropertyKey, newValue: any) {
        if (typeof newValue == "object") {
            newValue = { id: this.om.getMetadata(newValue).id };
        }
        else {
            newValue = this.om.serialize(newValue);
        }
        this.send({
            command: "set",
            id: this.om.getMetadata(obj).id,
            data: {
                property: property,
                newValue: newValue
            }
        })
    }

    private notifyNewType(typeInfo: ITypeMetadata) {

        let info = {
            name: typeInfo.name,
            methods: [...typeInfo.methods.keys()]
        }

        this.send({
            command: "newType",
            data: info
        });
    }


}


interface ICommand {
    command: string,
    id: number,
    data: any
}

class Client {

    private socket: WebSocket;
    public root: any;
    private objects: { [id: number]: any };


    constructor(url: string) {
        this.socket = new WebSocket(url);
        this.objects = {};


        this.socket.on("open", () => {
            console.log("socket open");
        });

        this.socket.on("message", (data, flags) => {
            this.processMessage(JSON.parse(data));
        })
    }

    private processMessage(cmd: ICommand) {
        console.log(cmd);
        switch (cmd.command) {
            case "new":
                {
                    let obj = cmd.data;
                    let id = cmd.id;
                    this.objects[id] = obj;

                    let self = this;

                    let keys = Object.keys(obj);
                    keys.forEach(key => {
                        let value = obj[key];
                        if (typeof value == "object") {
                            if (value._type && value._type == "function") {
                                obj[key] = function () {

                                    console.log("Function " + key + " called on " + id);
                                };
                            }
                            else {
                                obj[key] = this.objects[value.id];
                            }
                        }

                    });

                    if (obj._type && obj._type === "array") {
                        let arr: any[] = [];
                        keys.forEach(key => {
                            if (key !== "_type")
                                arr[parseInt(key, 10)] = obj[key];
                        });
                        this.objects[cmd.id] = obj = arr;

                    }

                    if (cmd.id == 0) {
                        this.root = obj;
                        console.log("root");
                        console.log(obj);
                    }


                } break;
            case "set":
                {
                    let obj = this.objects[cmd.id];
                    let value = cmd.data.newValue;
                    if (typeof value == "object") {
                        value = this.objects[value.id];
                    }
                    obj[cmd.data.property] = value;

                    console.log("set");
                    console.log(obj);
                }
        }
    }

}



function main() {

    let app = express();
    var server = http.createServer(app);

    // Configuration
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(bodyParser.json({ limit: "10mb" }));
    app.use(methodOverride());
    app.use(express.static(__dirname + "/static"));

    let env = process.env.NODE_ENV || "development";
    if (env === "development") {
        app.use(errorHandler());
    }



    var model: Thing[] = [];
    var t = new Thing("blue", 4, new Person("Javi", 37));

    var om = new Omniscient(server);

    om.on("new", (meta: IObjectMetadata) => {

        let st = JSON.stringify(om.serialize(meta.originalObject));
        console.log(`New object with id ${meta.id}`);
        console.log(st);
    });

    om.on("set", (target: any, property: PropertyKey, value: any) => {
        var meta = om.getMetadata(target);
        console.log(`set ${meta.id}.${property} = '${value}'`);
    });

    model[0] = t;
    om.root["model"] = model;

    let o = { color: "yellow" };
    let p = om.getProxy(o);
    let a = om.getProxy(p);

    console.log(a === p);

    console.log(om.getMetadata(o).id);
    console.log(om.getMetadata(p).id);
    console.log(om.getMetadata(a).id);

    let proto = Object.getPrototypeOf(om);
    console.log("proto=" + (om.constructor == Omniscient));

    log.info("server.listen");
    server.listen(4000);


    var c = new Client("http://localhost:4000");


    setTimeout(() => {
        let root = om.getProxy(om.root);
        root.model[0].color = { features: "green", taste: () => { console.log("hello"); } };
        console.log(om.getAliveIds());
    }, 2000);

    setTimeout(() => {

        c.root.model[0].color.taste();


    }, 4000);

}

main();

