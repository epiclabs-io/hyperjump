

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

export interface ITypeInfo {
    name: string,
    methods: { [methodName: string]: number };
    clientMethods: { [methodName: string]: IFunctionDefinition };
    serializationInfo?: ISerializationInfo;
    referenceType: RefType;
}

export interface IByRef {
    _construct?: ITypeInfo,
    _byRef: number
}

export interface ICommand {
    command: string,
    debugInfo?:string
}
export interface IRoot {
    getType(typeName: string): Promise<ITypeInfo>;
    pingObjects(obj: any[]): Promise<void>;
    getObject(nameOrId: string|number): Promise<any>;
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
    id:number,
    length:number
}

export var DateTypeInfo: ITypeInfo = {
    name: "Date",
    methods: null,
    clientMethods: null,
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