

export interface IFunctionDefinition {
    args: string[];
    body: string;
}

export const ROOT_FUNCTION_GET_TYPE = 1;
export const ROOT_FUNCTION_GET_OBJECT = 2;

export enum RefType {
    VALUE, // type is passed by value
    REFVALUE, //type is passed by reference, alongside a snapshot of properties
    REFONLY // type is passed by reference without properties
}


export interface ISerializationInfo {
    serialize: (obj: any) => any;
    deserialize: (obj: any) => any;
    serializerDef: IFunctionDefinition;
    deserializerDef: IFunctionDefinition;
}

export type IPropertyInfo = { [propertyName: string]: string };
export type ISerializeMetadata = IPropertyInfo;


export interface Type extends Function {
    serializeMetadata?: ISerializeMetadata;
}

export interface ITypeInfo {
    name: string,
    methods: { [methodName: string]: number };
    properties: IPropertyInfo;
    clientMethods: { [methodName: string]: IFunctionDefinition };
    serializationInfo?: ISerializationInfo;
    referenceType: RefType;
}



export type IPropertyMetadata = string;

export interface ITypeMetadata {
    name: string;
    referenceType: RefType;
    methods: string[];
    clientMethods: { [methodName: string]: Function };
    properties: { [propertyName: string]: IPropertyMetadata };
    serialize: (obj: any) => any;
    deserialize: (obj: any) => any;
}



export interface IByRef {
    _construct?: ITypeInfo,
    _byRef: number
}

export interface ICommand {
    command: string,
    debugInfo?: string
}
export interface IRoot {
    getType(typeName: string): Promise<ITypeInfo>;
    pingObjects(obj: any[]): Promise<void>;
    getObject(nameOrId: string | number): Promise<any>;
    listen(obj: any, eventName: string): Promise<void>;
    unlisten(obj: any, eventName: string): Promise<void>;
}
export interface IInvokeCommand extends ICommand {
    functionId: number,
    callId: number,
    thisArg: any,
    args: any[]

}

export interface IInvokeResultCommand extends ICommand {
    callId: number,
    result: any,
    status: number,
    message?: string
}

export interface IEventFiredCommand extends ICommand {
    sourceObjectId: any,
    eventName: string,
    args: any[]
}

export interface IBinaryDataHeaderCommand extends ICommand {
    id: number,
    length: number
}

export var DateTypeInfo: ITypeInfo = {
    name: "Date",
    methods: null,
    clientMethods: null,
    properties: {},
    referenceType: RefType.VALUE,
    serializationInfo: {
        serialize: (obj: any): any => {
            return { time: (obj as Date).getTime() };
        },
        deserialize: (obj: any): any => {
            return new Date(obj.time);
        },
        serializerDef: null,
        deserializerDef: null
    }

}

export var MapTypeInfo: ITypeInfo = {
    name: "Map",
    methods: null,
    clientMethods: null,
    properties: {},
    referenceType: RefType.VALUE,

    serializationInfo: {
        serialize: (obj: any): any => {

            let m = {};
            let map = obj as Map<string | number, any>;
            map.forEach((value, key) => {
                m[key] = value;
            });
            return m;

        },
        deserialize: (obj: any): any => {
            let map = new Map<any, any>();
            Object.keys(obj).forEach(key => {
                map.set(key, obj[key]);
            });
            return map;
        },
        serializerDef: null,
        deserializerDef: null
    }
}