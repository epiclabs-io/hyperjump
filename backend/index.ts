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


class Person {
    age: number;
    name: string;

    constructor(name: string, age: number) {
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


class Ominscient extends events.EventEmitter {

    private objects: WeakMap<Object, IObjectMetadata>;
    private objectCounter: number = 0;
    private clients: { [id: number]: Client };

    constructor(server: http.Server) {
        super();
        this.clients = {};
        let wss = new WebSocket.Server({ server: server });
        let clientId = 0;

        wss.on("connection", (socket) => {
            let client = new Client(this, socket, clientId++);

            socket.on("error", (err) => {
                this.clean(client);
            });

            socket.on("close", (code, message) => {
                this.clean(client);
            });

            this.emit("connection", client);
        });


        this.objects = new WeakMap<Object, IObjectMetadata>();
    }

    private clean(client: Client) {
        delete this.clients[client.id];
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
            target[property] = value;
            this.emit("set", target, property, value);
            return true;
        }
    };




    public getProxy<T>(obj: T): T {

        return this.getMetadata(obj).proxy;
    }
    public getMetadata<T>(obj: T): IObjectMetadata {
        let self = this;
        let metadata = this.objects.get(obj);
        if (metadata)
            return metadata;

        let pr = new Proxy(obj, this.proxyHandler);

        metadata = {
            proxy: pr,
            originalObject: obj,
            id: this.objectCounter++
        }
        this.objects.set(obj, metadata);
        this.emit("new", metadata);


        return metadata;
    }

    public serialize(obj: any): any {
        //obj = this.getProxy(obj);
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
            } else {
                ret[key] = value;
            }

        });

        return ret;

    }

}


class Client {

    private om: Ominscient;
    private socket: WebSocket;
    public id: number;

    constructor(om: Ominscient, socket: WebSocket, id: number) {
        this.om = om;
        this.socket = socket;
        this.id = id;
    }

    public share(name:string, obj: any) {

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

    log.info("Hello");

    var model: Thing[] = [];
    var t = new Thing("blue", 4, new Person("Javi", 37));

    var om = new Ominscient(server);

    om.on("new", (meta: IObjectMetadata) => {

        let st = JSON.stringify(om.serialize(meta.originalObject));
        console.log(`New object with id ${meta.id}`);
        console.log(st);
    });

    om.on("set", (target: any, property: PropertyKey, value: any) => {
        var meta = om.getMetadata(target);
        console.log(`set ${meta.id}.${property} = '${value}'`);
    });

    model[1] = t;
    let p = om.getProxy(model);

    p[1].owner.age = 12;




}

main();

