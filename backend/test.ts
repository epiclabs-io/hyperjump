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

import * as hj from "./index";


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

    public print(st: any) {
        console.log("print any:" + st);
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

    var hjserver = new hj.HyperjumpServer(httpServer, "/test");

    hjserver.on("error", (error: string) => {
        log.error("server Error: " + error);
    });

    hjserver.registerType(Thing, "Thing");
    hjserver.registerMethod(Thing, "speak");
    hjserver.registerMethod(Thing, "print");
    hjserver.registerObject(t, "testobj");


    setInterval(() => {
        hjserver.fireEvent(t, "tick", new Date());
    }, 1000);

    hjserver.registerMethodEx(hjserver.constructor, function (a: number, b: number) {
        return a + b;
    }, "sum");

    log.info("server.listen");
    httpServer.listen(4000);


    var c = new hj.HyperjumpClient();
    c.loglevel = 1;
    c.debugMode = true;
    c.connect("http://localhost:4000/test");

    c.on("ready", async () => {
        console.log("Root!");

        let t = await c.root.getObject("testobj");

        let ret = await t.speak("perry");

        let count = 0;
        let listener = (source: any, val: any) => {
            console.log("tick " + val);
            count++;
            if (count == 2) {
                c.unlisten(t, "tick", listener);
            }
        }
        c.listen(t, "tick", listener);

        await c.refresh(t);

        console.log(ret);
    });

    setTimeout(async () => {

        await t.print("Hola");
        await t.print(new Date());

    }, 4000);

    setTimeout(() => {



    }, 14000);

}


main();

