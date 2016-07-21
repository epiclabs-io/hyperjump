declare class SyncClient {

    root: any;
    constructor(socket: any);
    on(label: string, callback: Function): void;
    removeListener(label: string, callback: Function): boolean;
    emit(label: string, ...args: any[]): boolean;
}
