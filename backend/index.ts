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

import {Omniscient} from "./Omniscient";
import {IObjectMetadata} from "./Omniscient";
import {Client} from "./Client";


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


    om.registerType(Thing,"Thing");
    om.registerMethod(Thing, Thing.prototype.speak);


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

