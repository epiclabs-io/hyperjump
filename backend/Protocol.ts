

export interface IFunctionDefinition{
    args:string[];
    body:string;
}

export interface ITypeInfo {
    name: string,
    methods: { [methodName: string]: number },
    clientMethods:{ [methodName: string]: IFunctionDefinition };
}

export interface IByRef {
    _construct?: ITypeInfo,
    _byRef: number
}

export interface ICommand {
    command: string,
}

export interface INewObjectCommand extends ICommand {
    newObj: any,
    objectId: number
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

export interface ISetPropertyCommand extends ICommand {
    objectId: number,
    property: string,
    value: any
}

export interface INewTypeCommand extends ICommand {
    typeInfo: ITypeInfo
}

export interface IKeepAliveCommand extends ICommand {
    aliveIds: number[]
}

export interface IDeleteCommand extends ICommand {
    objectId: number,
    property: string
}

