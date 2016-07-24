
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
    private objecIds = new WeakMap<any, number>();
    private typesByName = new Map<string, ILocalTypeInfo>();
    private calls = new Map<number, IPromiseInfo>();

    constructor(socket: any) {
        super();
        this.socket = socket;

        this.socket.onopen = () => {
            console.log("socket open");
            let root = { _byRef: 0 };
            this.invokeRemoteFunction(2, root, [0] as any).then(obj => {
                this.root = obj;
                this.emit("root");
            })
        };

        this.socket.onmessage = (event) => {
            this.processMessage(JSON.parse(event.data));
        };

        this.socket.onerror = (ev) => {
            log.error(ev.toString());
        }
    }


    private processMessage(cmd: Protocol.ICommand) {
        console.log(cmd);
        switch (cmd.command) {
            case "result": this.process_result(cmd as Protocol.IInvokeResultCommand); break;
            default: {
                log.warn("Unknown cmd type " + cmd.command);
            }
        }
    }

    private makeType(typeInfo: Protocol.ITypeInfo): ILocalTypeInfo {
        let localTypeInfo = typeInfo as ILocalTypeInfo;
        let Proto = function (): any { };
        Proto["_type"] = typeInfo.name;

        for (var methodName of Object.keys(typeInfo.methods)) {
            Proto.prototype[methodName] = this.generateProxyFunction(typeInfo.methods[methodName]);
        }

        for (var methodName of Object.keys(typeInfo.clientMethods)) {
            let clientMethodInfo = typeInfo.clientMethods[methodName];
            Proto.prototype[methodName] = new Function(...clientMethodInfo.args, clientMethodInfo.body);
        }

        localTypeInfo.prototype = Proto as any;

        this.typesByName.set(typeInfo.name, localTypeInfo);
        return localTypeInfo;
    }

    private getType(typeName: string): Promise<Function> {
        let typeInfo = this.typesByName.get(typeName);
        if (typeInfo) {
            return Promise.resolve(typeInfo.prototype);
        }

        return new Promise<Function>((resolve, reject) => {

            let typeReceived = (typeInfo?: Protocol.ITypeInfo) => {
                let localTypeInfo = this.makeType(typeInfo);
                resolve(localTypeInfo.prototype);

            }

            let typeNotFound = (err: Error) => {
                reject(err);
            }

            this.idCall++;
            this.calls.set(this.idCall, { resolve: typeReceived, reject: typeNotFound });
            let cmd: Protocol.IInvokeCommand = {
                command: "invoke",
                functionId: 1, //getType
                callId: this.idCall,
                thisArg: { _byRef: 0 }, //Root
                args: [typeName],
            }
            this.send(cmd);


        });

    }

    private serialize(obj: any): any {

        if (Array.isArray(obj)) {
            let arr: any[] = [];
            (obj as any[]).forEach(element => {
                arr.push(this.serialize(element));
            });
            return arr;
        }

        if (typeof obj !== "object" || obj == null || obj == undefined)
            return obj; //primitive type

        if (obj.constructor._type) {
            let id = this.objecIds.get(obj);
            if (id === undefined) {
                log.error(`Unknown object with id ${id}.`);
                return null;
            }
            return { _byRef: id };
        }

        let ret: any = {};

        let keys = Object.keys(obj);
        keys.forEach(key => {
            ret[key] = this.serialize(obj[key]);
        });

        return ret;

    }

    private deserializeFast(obj: any): any {

        if (Array.isArray(obj)) {
            let arr: any[] = [];
            (obj as any[]).forEach(element => {
                arr.push(this.deserializeFast(element));
            });
            return arr;
        }

        if (typeof obj !== "object" || obj == null || obj == undefined)
            return obj; //primitive type

        let ret: any;
        if (obj._byRef !== undefined && obj._type) {
            let typeInfo = this.typesByName.get(obj._type);
            if (typeInfo == undefined)
                throw {
                    message: "Unknown type",
                    typeName: obj._type
                };
            ret = new typeInfo.prototype();
            this.objecIds.set(ret, obj._byRef);
            delete obj._byRef;
            delete obj._type;

        }
        else
            ret = {};

        let keys = Object.keys(obj);
        keys.forEach(key => {
            ret[key] = this.deserializeFast(obj[key]);
        });

        return ret;

    }

    private deserialize(obj: any): Promise<any> {
        let ret: any;
        try {
            ret = this.deserializeFast(obj);
            return Promise.resolve(ret);
        }
        catch (err) {
            if (err.typeName) {
                return new Promise((resolve, reject) => {
                    this.getType(err.typeName).then(typeInfo => {
                        this.deserialize(obj).then(resolve);
                    }).catch(err => {
                        reject(err);
                    });
                });
            }
        }
    }



    private process_result(cmd: Protocol.IInvokeResultCommand) {

        let promiseInfo = this.calls.get(cmd.callId);
        if (!promiseInfo) {
            log.error(`call id ${cmd.callId} not found`);
            return;
        }

        this.calls.delete(cmd.callId);

        if (cmd.status == 0) {
            this.deserialize(cmd.result).then(promiseInfo.resolve);

        } else
            promiseInfo.reject(cmd.message);
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
            return { _byRef: id };
    }

    private idCall = 0;
    private invokeRemoteFunction(id: number, thisArg: any, args: IArguments = null) {
        thisArg = this.serialize(thisArg);
        let a: any[] = [];
        if (args) {
            for (var i = 0; i < args.length; i++) {
                a[i] = this.serialize(args[i]);
            }
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
