
declare module "hyperjump/client-browser/Client" {

    class EventEmitter {
        private listeners;
        constructor();
        on(label: string, callback: Function): void;
        once(label: string, callback: Function): void;
        removeListener(label: string, callback: Function): boolean;
        emit(label: string, ...args: any[]): boolean;
    }
    export interface ISerializationInfo {
        serialize: (obj: any) => any;
        deserialize: (obj: any) => any;
        serializerDef: IFunctionDefinition;
        deserializerDef: IFunctionDefinition;
    }
    export interface IFunctionDefinition {
        args: string[];
        body: string;
    }
    export interface ITypeInfo {
        name: string;
        methods: {
            [methodName: string]: number;
        };
        clientMethods: {
            [methodName: string]: IFunctionDefinition;
        };
        serializationInfo?: ISerializationInfo;
        isByRef: boolean;
    }

    export interface ILocalTypeInfo extends ITypeInfo {
        prototype: {
            new (): any;
        };
    }
    export interface IHyperJumpEventHandler {
        (source: any, ...args: any[]): void;
    }

    export interface IRemoteObjectInfo {
        events: Map<string, Set<IHyperJumpEventHandler>>;
        obj: any;
    }

    export interface IRoot {
        getType(typeName: string): Promise<ITypeInfo>;
        getObject(nameOrId: number|string): Promise<any>;
        pingObjects(obj: any[]): Promise<void>;
       
        //listen(obj: any, eventName: string):Promise<void>;
        //unlisten(obj: any, eventName: string):Promise<void>;
    }

    export class HyperjumpClient extends EventEmitter {
        root: IRoot;
        constructor(socket: any);
        registerTypeInfo(type: Function, typeInfo: ILocalTypeInfo): void;
        track(obj: any): IRemoteObjectInfo;
        untrack(obj: any): void;
        listen(obj: any, eventName: string, listener: Function): Promise<void>;
        unlisten(obj: any, eventName: string, listener: Function): Promise<any>;
    }
}