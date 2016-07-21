
import * as Protocol from "./Protocol";
import {EventEmitter} from "./EventEmitter";

var log = {
    log: function (type: string, st: string) {
        console.log(`modelsync-client [${type}]: ${st}`);
    },
    info: function (st: string) {
        this.log("INFO", st);
    },
    warn: function (st: string) {
        this.log("WARN", st);
    },
    error: function (st: string) {
        this.log("ERROR", st);
    },
}

interface ILocalTypeInfo extends Protocol.ITypeInfo {
    prototype: { new (): any };
}

interface IPromiseInfo {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
}

export class SyncClient extends EventEmitter {

    private socket: WebSocket;
    public root: any;
    private objects = new Map<number, any>();
    private objecIds = new WeakMap<any, number>();
    private typesByName = new Map<string, ILocalTypeInfo>();
    private calls = new Map<number, IPromiseInfo>();

    constructor(socket: any) {
        super();
        this.socket = socket;

        this.socket.onopen = () => {
            console.log("socket open");
        };

        this.socket.onmessage = (event) => {
            this.processMessage(JSON.parse(event.data));
        };

        this.socket.onerror = (ev) => {
            log.error(ev.toString());
        }
    }



    private getObject(obj: any | Protocol.IByRef): any {
        if (typeof obj == "object" && obj != null && obj != undefined) {
            let id = (obj as Protocol.IByRef)._byref;
            if (id == undefined) {
                return obj; // byValue object
            }
            obj = this.objects.get(id);
            if (obj == undefined) {
                log.error(`Unknown Object id ${id}`);
            }
        }
        return obj;
    }

    private processMessage(cmd: Protocol.ICommand) {
        console.log(cmd);
        switch (cmd.command) {
            case "new": this.process_new(cmd as Protocol.INewObjectCommand); break;
            case "set": this.process_set(cmd as Protocol.ISetPropertyCommand); break;
            case "newType": this.process_newType(cmd as Protocol.INewTypeCommand); break;
            case "result": this.process_result(cmd as Protocol.IInvokeResultCommand); break;
            case "alive": this.process_alive(cmd as Protocol.IKeepAliveCommand); break;
            default: {
                log.warn("Unknown cmd type " + cmd.command);
            }
        }
    }

    private process_new(cmd: Protocol.INewObjectCommand) {
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

        this.emit("new", newObj);

        if (id == 0) {
            this.root = newObj;
            console.log("root");
            console.log(newObj);
            this.emit("sync");
        }
    }

    private process_set(cmd: Protocol.ISetPropertyCommand) {
        let obj = this.objects.get(cmd.objectId);
        let value = this.getObject(cmd.value);
        obj[cmd.property] = value;

        console.log("set");
        console.log(obj);
    }

    private process_newType(cmd: Protocol.INewTypeCommand) {
        let typeInfo = cmd.typeInfo as ILocalTypeInfo;

        let Proto = function (): any { }

        for (var methodName of Object.keys(typeInfo.methods)) {
            Proto.prototype[methodName] = this.generateProxyFunction(typeInfo.methods[methodName]);
        }

        typeInfo.prototype = Proto as any;

        this.typesByName.set(typeInfo.name, typeInfo);
    }

    private process_result(cmd: Protocol.IInvokeResultCommand) {

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

    private process_alive(cmd: Protocol.IKeepAliveCommand) {
        let objects = this.objects;
        this.objects = new Map<number, any>();
        cmd.aliveIds.forEach(id => {
            let obj = objects.get(id);
            if (obj)
                this.objects.set(id, obj);
        });
    }

    private process_delete(cmd: Protocol.IDeleteCommand) {
        let obj = this.getObject(cmd.objectId);
        this.emit("delete", obj, cmd.property);
        delete obj[cmd.property];
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
            let cmd: Protocol.IInvokeCommand = {
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
