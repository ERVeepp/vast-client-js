import { XHRURLHandler } from './urlhandlers/xmlhttprequest';
import { FlashURLHandler } from './urlhandlers/flash';
import { NodeURLHandler } from './urlhandlers/node'

export class URLHandler {
    constructor() {
        this.flash = new FlashURLHandler();
        this.xhr = new XHRURLHandler();
    }

    get(url, options, cb) {
        // Allow skip of the options param
        if (!cb) {
            if (typeof options === 'function') { cb = options; }
            options = {};
        }

        if (options.response) {
            // Trick: the VAST response XML document is passed as an option
            const { response } = options;
            delete options.response;

            cb(null, response);
        } else if (options.urlhandler && options.urlhandler.supported()) {
            // explicitly supply your own URLHandler object
            return options.urlhandler.get(url, options, cb);
        } else if (typeof window === 'undefined' || window === null) {
            // prevents browserify from including this file
            const nodeUrlHandler = new NodeURLHandler();
            return nodeUrlHandler.get(url, options, cb);
        } else if (this.xhr.supported()) {
            return this.xhr.get(url, options, cb);
        } else if (this.flash.supported()) {
            return this.flash.get(url, options, cb);
        } else {
            cb(new Error('Current context is not supported by any of the default URLHandlers. Please provide a custom URLHandler'));
        }
    }
}
