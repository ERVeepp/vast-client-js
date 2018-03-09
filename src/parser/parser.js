/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS205: Consider reworking code to avoid use of IIFEs
 * DS206: Consider reworking classes to avoid initClass
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
import AdParser from './ad_parser.coffee';
import ParserUtils from './parser_utils.coffee';
import { URLHandler } from '../url_handler';
import { VASTResponse } from '../vast_response';
import VASTUtil from '../util.coffee';
import { EventEmitter } from 'events';

const DEFAULT_MAX_WRAPPER_WIDTH = 10;

const DEFAULT_EVENT_DATA = {
    ERRORCODE  : 900,
    extensions : []
};

var VASTParser = (function() {
    let maxWrapperDepth = undefined;
    let URLTemplateFilters = undefined;
    VASTParser = class VASTParser {
        static initClass() {
            maxWrapperDepth = null;
            URLTemplateFilters = [];
            this.utils = new ParserUtils();
            this.adParser = new AdParser();

            this.vent = new EventEmitter();

            this.parseXmlDocument = (url, parentURLs, options, xml, cb) => {
                // Current VAST depth
                let ad;
                const wrapperDepth = options.wrapperDepth++;

                const response = new VASTResponse();

                if (((xml != null ? xml.documentElement : undefined) == null) || (xml.documentElement.nodeName !== "VAST")) {
                    return cb(new Error('Invalid VAST XMLDocument'));
                }

                for (var node of Array.from(xml.documentElement.childNodes)) {
                    if (node.nodeName === 'Error') {
                        response.errorURLTemplates.push((this.utils.parseNodeText(node)));
                    }
                }

                for (node of Array.from(xml.documentElement.childNodes)) {
                    if (node.nodeName === 'Ad') {
                        ad = this.parseAdElement(node);
                        if (ad != null) {
                            response.ads.push(ad);
                        } else {
                            // VAST version of response not supported.
                            this.track(response.errorURLTemplates, {ERRORCODE: 101});
                        }
                    }
                }

                const complete = () => {
                    let index;
                    for (index = response.ads.length - 1; index >= 0; index--) {
                        // Still some Wrappers URL to be resolved -> continue
                        ad = response.ads[index];
                        if (ad.nextWrapperURL != null) { return; }
                    }

                    // We've to wait for all <Ad> elements to be parsed before handling error so we can:
                    // - Send computed extensions data
                    // - Ping all <Error> URIs defined across VAST files
                    if (wrapperDepth === 0) {
                        // No Ad case - The parser never bump into an <Ad> element
                        if (response.ads.length === 0) {
                            this.track(response.errorURLTemplates, {ERRORCODE: 303});
                        } else {
                            for (index = response.ads.length - 1; index >= 0; index--) {
                                // - Error encountred while parsing
                                // - No Creative case - The parser has dealt with soma <Ad><Wrapper> or/and an <Ad><Inline> elements
                                // but no creative was found
                                ad = response.ads[index];
                                if (ad.errorCode || (ad.creatives.length === 0)) {
                                    this.track(
                                        ad.errorURLTemplates.concat(response.errorURLTemplates),
                                        { ERRORCODE: ad.errorCode || 303 },
                                        { ERRORMESSAGE: ad.errorMessage || '' },
                                        { extensions : ad.extensions },
                                        { system: ad.system }
                                    );
                                    response.ads.splice(index, 1);
                                }
                            }
                        }
                    }

                    return cb(null, response);
                };

                let loopIndex = response.ads.length;
                while (loopIndex--) {
                    ad = response.ads[loopIndex];
                    if (ad.nextWrapperURL == null) { continue; }
                    (ad => {
                        if ((parentURLs.length >= maxWrapperDepth) || Array.from(parentURLs).includes(ad.nextWrapperURL)) {
                            // Wrapper limit reached, as defined by the video player.
                            // Too many Wrapper responses have been received with no InLine response.
                            ad.errorCode = 302;
                            delete ad.nextWrapperURL;
                            return;
                        }

                        // Get full URL
                        ad.nextWrapperURL = this.resolveVastAdTagURI(ad.nextWrapperURL, url);

                        return this._parse(ad.nextWrapperURL, parentURLs, options, (err, wrappedResponse) => {
                            delete ad.nextWrapperURL;

                            if (err != null) {
                                // Timeout of VAST URI provided in Wrapper element, or of VAST URI provided in a subsequent Wrapper element.
                                // (URI was either unavailable or reached a timeout as defined by the video player.)
                                ad.errorCode = 301;
                                ad.errorMessage = err.message;
                                complete();
                                return;
                            }

                            if ((wrappedResponse != null ? wrappedResponse.errorURLTemplates : undefined) != null) {
                                response.errorURLTemplates = response.errorURLTemplates.concat(wrappedResponse.errorURLTemplates);
                            }

                            if (wrappedResponse.ads.length === 0) {
                                // No ads returned by the wrappedResponse, discard current <Ad><Wrapper> creatives
                                ad.creatives = [];
                            } else {
                                let index = response.ads.indexOf(ad);
                                response.ads.splice(index, 1);

                                for (let wrappedAd of Array.from(wrappedResponse.ads)) {
                                    this.mergeWrapperAdData(wrappedAd, ad);
                                    response.ads.splice(++index, 0, wrappedAd);
                                }
                            }

                            return complete();
                        });
                    })(ad);
                }

                return complete();
            };
        }

        static addURLTemplateFilter(func) {
            if (typeof func === 'function') { URLTemplateFilters.push(func); }
        }

        static removeURLTemplateFilter() { return URLTemplateFilters.pop(); }
        static countURLTemplateFilters() { return URLTemplateFilters.length; }
        static clearUrlTemplateFilters() { return URLTemplateFilters = []; }

        static parse(url, options, cb) {
            if (!cb) {
                if (typeof options === 'function') { cb = options; }
                options = {};
            }

            maxWrapperDepth = options.wrapperLimit || DEFAULT_MAX_WRAPPER_WIDTH;
            options.wrapperDepth = 0;

            return this._parse(url, null, options, (err, response) => cb(response, err));
        }

        static load(xml, options, cb) {
            if (!cb) {
                if (typeof options === 'function') { cb = options; }
                options = {};
            }

            return this.parseXmlDocument(null, [], options, xml, cb);
        }
        static track(templates, errorCode, ...data) {
            this.vent.emit('VAST-error', VASTUtil.merge(DEFAULT_EVENT_DATA, errorCode, ...Array.from(data)));
            return VASTUtil.track(templates, errorCode);
        }

        static on(eventName, cb) {
            return this.vent.on(eventName, cb);
        }

        static once(eventName, cb) {
            return this.vent.once(eventName, cb);
        }

        static off(eventName, cb) {
            return this.vent.removeListener(eventName, cb);
        }

        static _parse(url, parentURLs, options, cb) {
            // Process url with defined filter
            for (let filter of Array.from(URLTemplateFilters)) { url = filter(url); }

            if (parentURLs == null) { parentURLs = []; }
            parentURLs.push(url);

            this.vent.emit('resolving', { url });

            return URLHandler.get(url, options, (err, xml) => {
                this.vent.emit('resolved', { url });

                if (err != null) { return cb(err); }
                return this.parseXmlDocument(url, parentURLs, options, xml, cb);
            });
        }

        // Convert relative vastAdTagUri
        static resolveVastAdTagURI(vastAdTagUrl, originalUrl) {
            if (vastAdTagUrl.indexOf('//') === 0) {
                const { protocol } = location;
                return `${protocol}${vastAdTagUrl}`;
            }

            if (vastAdTagUrl.indexOf('://') === -1) {
                // Resolve relative URLs (mainly for unit testing)
                const baseURL = originalUrl.slice(0, originalUrl.lastIndexOf('/'));
                return `${baseURL}/${vastAdTagUrl}`;
            }

            return vastAdTagUrl;
        }

        // Merge ad tracking URLs / extensions data into wrappedAd
        static mergeWrapperAdData(wrappedAd, ad) {
            wrappedAd.errorURLTemplates = ad.errorURLTemplates.concat(wrappedAd.errorURLTemplates);
            wrappedAd.impressionURLTemplates = ad.impressionURLTemplates.concat(wrappedAd.impressionURLTemplates);
            wrappedAd.extensions = ad.extensions.concat(wrappedAd.extensions);

            for (var creative of Array.from(wrappedAd.creatives)) {
                if ((ad.trackingEvents != null ? ad.trackingEvents[creative.type] : undefined) != null) {
                    for (let eventName in ad.trackingEvents[creative.type]) {
                        const urls = ad.trackingEvents[creative.type][eventName];
                        if (!creative.trackingEvents[eventName]) { creative.trackingEvents[eventName] = []; }
                        creative.trackingEvents[eventName] = creative.trackingEvents[eventName].concat(urls);
                    }
                }
            }

            if (ad.videoClickTrackingURLTemplates != null ? ad.videoClickTrackingURLTemplates.length : undefined) {
                for (creative of Array.from(wrappedAd.creatives)) {
                    if (creative.type === 'linear') {
                        creative.videoClickTrackingURLTemplates = creative.videoClickTrackingURLTemplates.concat(ad.videoClickTrackingURLTemplates);
                    }
                }
            }

            if (ad.videoCustomClickURLTemplates != null ? ad.videoCustomClickURLTemplates.length : undefined) {
                for (creative of Array.from(wrappedAd.creatives)) {
                    if (creative.type === 'linear') {
                        creative.videoCustomClickURLTemplates = creative.videoCustomClickURLTemplates.concat(ad.videoCustomClickURLTemplates);
                    }
                }
            }

            // VAST 2.0 support - Use Wrapper/linear/clickThrough when Inline/Linear/clickThrough is null
            if (ad.videoClickThroughURLTemplate != null) {
                return (() => {
                    const result = [];
                    for (creative of Array.from(wrappedAd.creatives)) {
                        if ((creative.type === 'linear') && (creative.videoClickThroughURLTemplate == null)) {
                            result.push(creative.videoClickThroughURLTemplate = ad.videoClickThroughURLTemplate);
                        } else {
                            result.push(undefined);
                        }
                    }
                    return result;
                })();
            }
        }

        static parseAdElement(adElement) {
            for (let adTypeElement of Array.from(adElement.childNodes)) {
                if (!["Wrapper", "InLine"].includes(adTypeElement.nodeName)) { continue; }

                this.utils.copyNodeAttribute("id", adElement, adTypeElement);
                this.utils.copyNodeAttribute("sequence", adElement, adTypeElement);

                if (adTypeElement.nodeName === "Wrapper") {
                    return this.parseWrapperElement(adTypeElement);
                } else if (adTypeElement.nodeName === "InLine") {
                    return this.adParser.parse(adTypeElement);
                }
            }
        }

        static parseWrapperElement(wrapperElement) {
            const ad = this.adParser.parse(wrapperElement);
            let wrapperURLElement = this.utils.childByName(wrapperElement, "VASTAdTagURI");
            if (wrapperURLElement != null) {
                ad.nextWrapperURL = this.utils.parseNodeText(wrapperURLElement);
            } else {
                wrapperURLElement = this.utils.childByName(wrapperElement, "VASTAdTagURL");
                if (wrapperURLElement != null) {
                    ad.nextWrapperURL = this.utils.parseNodeText(this.utils.childByName(wrapperURLElement, "URL"));
                }
            }

            for (let wrapperCreativeElement of Array.from(ad.creatives)) {
                if (['linear', 'nonlinear'].includes(wrapperCreativeElement.type)) {
                    // TrackingEvents Linear / NonLinear
                    var item;
                    if (wrapperCreativeElement.trackingEvents != null) {
                        if (!ad.trackingEvents) { ad.trackingEvents = {}; }
                        if (!ad.trackingEvents[wrapperCreativeElement.type]) { ad.trackingEvents[wrapperCreativeElement.type] = {}; }
                        for (let eventName in wrapperCreativeElement.trackingEvents) {
                            const urls = wrapperCreativeElement.trackingEvents[eventName];
                            if (!ad.trackingEvents[wrapperCreativeElement.type][eventName]) { ad.trackingEvents[wrapperCreativeElement.type][eventName] = []; }
                            for (let url of Array.from(urls)) { ad.trackingEvents[wrapperCreativeElement.type][eventName].push(url); }
                        }
                    }
                    // ClickTracking
                    if (wrapperCreativeElement.videoClickTrackingURLTemplates != null) {
                        if (!ad.videoClickTrackingURLTemplates) { ad.videoClickTrackingURLTemplates = []; } // tmp property to save wrapper tracking URLs until they are merged
                        for (item of Array.from(wrapperCreativeElement.videoClickTrackingURLTemplates)) { ad.videoClickTrackingURLTemplates.push(item); }
                    }
                    // ClickThrough
                    if (wrapperCreativeElement.videoClickThroughURLTemplate != null) {
                        ad.videoClickThroughURLTemplate = wrapperCreativeElement.videoClickThroughURLTemplate;
                    }
                    // CustomClick
                    if (wrapperCreativeElement.videoCustomClickURLTemplates != null) {
                        if (!ad.videoCustomClickURLTemplates) { ad.videoCustomClickURLTemplates = []; } // tmp property to save wrapper tracking URLs until they are merged
                        for (item of Array.from(wrapperCreativeElement.videoCustomClickURLTemplates)) { ad.videoCustomClickURLTemplates.push(item); }
                    }
                }
            }

            if (ad.nextWrapperURL != null) {
                return ad;
            }
        }
    };
    VASTParser.initClass();
    return VASTParser;
})();

export default VASTParser;
