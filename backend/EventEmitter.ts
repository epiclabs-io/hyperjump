function isFunction(obj: any) {
    return typeof obj == 'function' || false;
};

export class EventEmitter {
    private listeners = new Map<string, Function[]>();
    constructor() {

    }
    public on(label: string, callback: Function) {
        this.listeners.has(label) || this.listeners.set(label, []);
        this.listeners.get(label).push(callback);
    }

    public once(label: string, callback: Function) {
        callback["once"] = true;
        this.on(label, callback);
    }

    public removeListener(label: string, callback: Function) {
        let listeners = this.listeners.get(label)
        let index: number;

        if (listeners && listeners.length) {
            index = listeners.reduce((i, listener, index) => {
                return (isFunction(listener) && listener === callback) ?
                    i = index :
                    i;
            }, -1);

            if (index > -1) {
                listeners.splice(index, 1);
                this.listeners.set(label, listeners);
                return true;
            }
        }
        return false;
    }
    public emit(label: string, ...args: any[]) {
        let listeners = this.listeners.get(label);

        let remainingListeners:Function[]=[];
        if (listeners && listeners.length) {
            listeners.forEach((listener) => {
                listener(...args);
                if (!listener["once"])
                    remainingListeners.push(listener);
            });
            this.listeners.set(label,remainingListeners);
            return true;
        }
        return false;
    }
}