

export interface IFunctionDefinition {
    args: string[];
    body: string;
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
    serializationInfo?:ISerializationInfo;
}

export interface IByRef {
    _construct?: ITypeInfo,
    _byRef: number
}

export interface ICommand {
    command: string,
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

export interface IEventListenCommand extends ICommand {
    objectId: number,
    eventName: string
}

export interface IEventUnListenCommand extends ICommand {
    objectId: number,
    eventName: string
}