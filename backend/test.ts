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

import * as om from "./index";


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
        super(`${name}'s being'`);
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
        let g = `${greeting}, my color is ${this.color}`;
        console.log(g);
        return g;
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

function main() {

    let app = express();
    var httpServer = http.createServer(app);

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
    var t = new Thing("blue", 4, new Person("Jay", 37));

    var omServer = new om.SyncServer(httpServer, "/test");

    omServer.on("new", (meta: any) => {

        let st = JSON.stringify(omServer.serialize(meta.originalObject));
        console.log(`New object with id ${meta.id}`);
        console.log(st);
    });

    omServer.on("set", (target: any, property: PropertyKey, value: any) => {
        var meta = omServer.getMetadata(target);
        console.log(`set ${meta.id}.${property} = '${value}'`);
    });

    omServer.on("error", (error: string) => {
        log.error("server Error: " + error);
    })


        ; omServer.registerType(Thing, "Thing");
    omServer.registerMethod(Thing, Thing.prototype.speak);
    //om.registerType(Person);

    model[0] = t;
    omServer.root["model"] = model;



    let proto = Object.getPrototypeOf(om);
    console.log("proto=" + (om.constructor == om.SyncServer));

    log.info("server.listen");
    httpServer.listen(4000);


    var c = new om.SyncClient(new WebSocket("http://localhost:3000/modelsync"));

    c.on("sync", () => {
        console.log("--------------ROOT-----------");
        console.log(JSON.stringify(c.root, null, "\t"));
    });


    /*
        setTimeout(() => {
            let root = om.getProxy(om.root);
            root.model[0].color = { features: "green", taste: () => { console.log("hello"); } };
            console.log(om.getAliveIds());
        }, 2000);
    
    */
    setTimeout(() => {



    }, 4000);

    setTimeout(() => {



    }, 14000);

}

main();

