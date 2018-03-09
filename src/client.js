import VASTParser from './parser/parser.js';
import VASTUtil from './util.js';

export class VASTClient {
    constructor() {
        this.cappingFreeLunch = 0;
        this.cappingMinimumTimeInterval = 0;
        this.options = {
            withCredentials : false,
            timeout : 0
        };
        this.storage = VASTUtil.storage;
        this.lastSuccessfullAd = 0;
        this.totalCalls = 0;
        this.totalCallsTimeout = 0;
    }

    get lastSuccessfullAd() {
        return this.storage.getItem('lastSuccessfullAd')
    }

    set lastSuccessfullAd(value) {
        return this.storage.getItem('lastSuccessfullAd', value)
    }

    get totalCalls() {
        return this.storage.getItem('totalCalls')
    }

    set totalCalls(value) {
        return this.storage.getItem('totalCalls', value)
    }

    get totalCallsTimeout() {
        return this.storage.getItem('totalCallsTimeout')
    }

    set totalCallsTimeout(value) {
        return this.storage.getItem('totalCallsTimeout', value)
    }

    get(url, opts, cb) {
        let options;
        const now = +new Date();

        if (!cb) {
            if (typeof opts === 'function') { cb = opts; }
            options = {};
        }

        options = Object.assign(this.options, opts);

        // Check totalCallsTimeout (first call + 1 hour), if older than now,
        // reset totalCalls number, by this way the client will be eligible again
        // for freelunch capping
        if (this.totalCallsTimeout < now) {
            this.totalCalls = 1;
            this.totalCallsTimeout = now + (60 * 60 * 1000);
        } else {
            this.totalCalls++;
        }

        if (this.cappingFreeLunch >= this.totalCalls) {
            return cb(null, new Error(`VAST call canceled – FreeLunch capping not reached yet ${this.totalCalls}/${this.cappingFreeLunch}`));
        }

        const timeSinceLastCall = now - this.lastSuccessfullAd;
        // Check timeSinceLastCall to be a positive number. If not, this mean the
        // previous was made in the future. We reset lastSuccessfullAd value
        if (timeSinceLastCall < 0) {
            this.lastSuccessfullAd = 0;
        } else if (timeSinceLastCall < this.cappingMinimumTimeInterval) {
            return cb(null, new Error(`VAST call canceled – (${this.cappingMinimumTimeInterval})ms minimum interval reached`));
        }

        return VASTParser.parse(url, options, (response, err) => {
            return cb(response, err);
        });
    }
}
