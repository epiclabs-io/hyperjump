
import {ITypeInfo} from "./Omniscient";
import {ICommand} from "./Omniscient";
import {IInvokeCommand} from "./Omniscient";
import {IInvokeResultCommand} from "./Omniscient";
import {INewObjectCommand} from "./Omniscient";
import {ISetPropertyCommand} from "./Omniscient";
import {INewTypeCommand} from "./Omniscient";
import {IKeepAliveCommand} from "./Omniscient";
import {IByRef} from "./Omniscient";

import * as loglevel from "loglevel";
import * as WebSocket from "ws";

var log = loglevel.getLogger("CLIENT");

interface ILocalTypeInfo extends ITypeInfo {
    prototype: { new (): any };
}

interface IPromiseInfo {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
}

export class Client {

    private socket: WebSocket;
    public root: any;
    private objects = new Map<number, any>();
    private objecIds = new WeakMap<any, number>();
    private typesByName = new Map<string, ILocalTypeInfo>();
    private calls = new Map<number, IPromiseInfo>();


    constructor(url: string) {
        this.socket = new WebSocket(url);

        this.socket.on("open", () => {
            console.log("socket open");
        });

        this.socket.on("message", (data, flags) => {
            this.processMessage(JSON.parse(data));
        })
    }



    private getObject(obj: any | IByRef): any {
        if (typeof obj == "object" && obj != null && obj != undefined) {
            let id = (obj as IByRef)._byref;
            if (id == undefined) {
                log.warn("id undefined");
            }
            obj = this.objects.get(id);
            if (obj == undefined) {
                log.error(`Unknown Object id ${id}`);
            }
        }
        return obj;
    }

    private processMessage(cmd: ICommand) {
        console.log(cmd);
        switch (cmd.command) {
            case "new": this.process_new(cmd as INewObjectCommand); break;
            case "set": this.process_set(cmd as ISetPropertyCommand); break;
            case "newType": this.process_newType(cmd as INewTypeCommand); break;
            case "result": this.process_result(cmd as IInvokeResultCommand); break;
            case "alive": this.process_alive(cmd as IKeepAliveCommand);break;
            default: {
                log.warn("Unknown cmd type " + cmd.command);
            }
        }
    }

    private process_new(cmd: INewObjectCommand) {
        let obj = cmd.newObj;
        let id = cmd.objectId;
        let self = this;

        let type = obj._type as string;
        if (type)
            delete obj._type;

        let keys = Object.keys(obj);
        let construct: any = Object;

        if (type) {

            if (type === "array") {
                let arr: any[] = [];
                keys.forEach(key => {
                    arr[parseInt(key, 10)] = obj[key];
                });
                obj = arr;
                this.objects.set(id, arr);
            } else {
                let typeInfo = this.typesByName.get(type);
                if (!typeInfo) {
                    log.error(`Unknown type ${type}`);
                    return;
                }

                construct = typeInfo.prototype;
            }
        }

        let newObj = new construct();

        keys.forEach(key => {
            let value = obj[key];
            newObj[key] = this.getObject(value);

        });

        this.objects.set(id, newObj);
        this.objecIds.set(newObj, id);

        if (id == 0) {
            this.root = newObj;
            console.log("root");
            console.log(newObj);
        }
    }

    private process_set(cmd: ISetPropertyCommand) {
        let obj = this.objects.get(cmd.objectId);
        let value = this.getObject(cmd.value);
        obj[cmd.property] = value;

        console.log("set");
        console.log(obj);
    }

    private process_newType(cmd: INewTypeCommand) {
        let typeInfo = cmd.typeInfo as ILocalTypeInfo;

        let Proto = function (): any { }

        for (var methodName of Object.keys(typeInfo.methods)) {
            Proto.prototype[methodName] = this.generateProxyFunction(typeInfo.methods[methodName]);
        }

        typeInfo.prototype = Proto as any;

        this.typesByName.set(typeInfo.name, typeInfo);
    }

    private process_result(cmd: IInvokeResultCommand) {

        let promiseInfo = this.calls.get(cmd.callId);
        if (!promiseInfo) {
            log.error(`call id ${cmd.callId} not found`);
            return;
        }

        this.calls.delete(cmd.callId);

        if (cmd.status == 0) {
            promiseInfo.resolve(this.getObject(cmd.result));
        } else
            promiseInfo.reject(cmd.message);
    }

    private process_alive(cmd: IKeepAliveCommand) {
        let objects = this.objects;
        this.objects = new Map<number, any>();
        cmd.aliveIds.forEach(id => {
            let obj = objects.get(id);
            if (obj)
                this.objects.set(id, obj);
        });
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
            return { _byref: id };
    }

    private idCall = 0;
    private invokeRemoteFunction(id: number, thisArg: any, args: IArguments) {
        thisArg = this.getRef(thisArg);
        let a: any[] = [];
        for (var i = 0; i < args.length; i++) {
            a[i] = this.getRef(args[i]);
        }
        this.idCall++;
        return new Promise<any>((resolve, reject) => {
            this.calls.set(this.idCall, { resolve, reject });
            let cmd: IInvokeCommand = {
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

}
