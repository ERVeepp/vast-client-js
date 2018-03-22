import { AdParser } from './ad_parser';
import { EventEmitter } from 'events';
import { ParserUtils } from './parser_utils';
import { URLHandler } from '../url_handler';
import { Util } from '../util';
import { VASTResponse } from '../vast_response';

const DEFAULT_MAX_WRAPPER_WIDTH = 10;
const DEFAULT_EVENT_DATA = {
  ERRORCODE: 900,
  extensions: []
};

export class VASTParser extends EventEmitter {
  constructor() {
    super();

    this.maxWrapperDepth = null;
    this.URLTemplateFilters = [];
    this.parentURLs = [];
    this.parserUtils = new ParserUtils();
    this.adParser = new AdParser();
    this.util = new Util();
    this.urlHandler = new URLHandler();
  }

  addURLTemplateFilter(filter) {
    if (typeof filter === 'function') {
      this.URLTemplateFilters.push(filter);
    }
  }

  removeURLTemplateFilter() {
    this.URLTemplateFilters.pop();
  }

  countURLTemplateFilters() {
    return this.URLTemplateFilters.length;
  }

  clearURLTemplateFilters() {
    this.URLTemplateFilters = [];
  }

  track(templates, errorCode, ...data) {
    this.emit(
      'VAST-error',
      this.util.merge(DEFAULT_EVENT_DATA, errorCode, ...data)
    );
    this.util.track(templates, errorCode);
  }

  fetchVAST(url, options) {
    return new Promise((resolve, reject) => {
      // Process url with defined filter
      for (let filter of this.URLTemplateFilters) {
        url = filter(url);
      }

      this.parentURLs.push(url);
      this.emit('resolving', { url });

      this.urlHandler.get(url, options, (err, xml) => {
        this.emit('resolved', { url });

        if (err != null) {
          reject(err);
        } else {
          resolve(xml);
        }
      });
    });
  }

  getAndParse(url, options, cb) {
    if (!cb) {
      if (typeof options === 'function') {
        cb = options;
        options = {};
      } else {
        throw new Error(
          'VASTParser getAndParse method called without valid callback function'
        );
      }
    }

    this.parentURLs = [];

    this.fetchVAST(url, options)
      .then(xml => {
        options.originalUrl = url;
        this.parse(xml, options, cb);
      })
      .catch(err => cb(err));
  }

  parse(vastXml, options, cb) {
    if (!cb) {
      if (typeof options === 'function') {
        cb = options;
        options = {};
      } else {
        throw new Error(
          'VASTParser parse method called without valid callback function'
        );
      }
    }

    // check if is a valid VAST document
    if (
      !vastXml ||
      !vastXml.documentElement ||
      vastXml.documentElement.nodeName !== 'VAST'
    ) {
      return cb(new Error('Invalid VAST XMLDocument'));
    }

    this.maxWrapperDepth = options.wrapperLimit || DEFAULT_MAX_WRAPPER_WIDTH;
    if (!options.wrapperDepth) {
      options.wrapperDepth = 0;
    }

    const vastResponse = new VASTResponse();
    const childNodes = vastXml.documentElement.childNodes;

    // Fill the VASTResponse object with ads and errorURLTemplates
    for (let nodeKey in childNodes) {
      const node = childNodes[nodeKey];

      if (node.nodeName === 'Error') {
        const errorURLTemplate = this.parserUtils.parseNodeText(node);

        vastResponse.errorURLTemplates.push(errorURLTemplate);
      }

      if (node.nodeName === 'Ad') {
        const ad = this.adParser.parse(node);

        if (ad != null) {
          vastResponse.ads.push(ad);
        } else {
          // VAST version of response not supported.
          this.track(vastResponse.errorURLTemplates, { ERRORCODE: 101 });
        }
      }
    }

    // vastResponse.ads is an array of Ads which can either be Inline
    // or wrapper: we need to recursively resolve all the wrappers
    // The recursion chain is:
    // parse -> resolveWrappers -> getAndParse -> parse -> resolveWrappers -> ...
    this.resolveWrappers(vastResponse, options, cb);
  }

  resolveWrappers(vastResponse, options, cb) {
    const wrapperDepth = options.wrapperDepth++;

    // Resolve all the wrappers
    for (let i = 0; i < vastResponse.ads.length; i++) {
      const ad = vastResponse.ads[i];

      // We already have a resolved VAST ad, no need to resolve wrapper
      if (ad.nextWrapperURL == null) {
        continue;
      }

      if (
        this.parentURLs.length >= this.maxWrapperDepth ||
        this.parentURLs.includes(ad.nextWrapperURL)
      ) {
        // Wrapper limit reached, as defined by the video player.
        // Too many Wrapper responses have been received with no InLine response.
        ad.errorCode = 302;
        delete ad.nextWrapperURL;
        this.completeWrapperResolving(vastResponse, wrapperDepth, cb);
        return;
      }

      // Get full URL
      ad.nextWrapperURL = this.parserUtils.resolveVastAdTagURI(
        ad.nextWrapperURL,
        options.originalUrl
      );

      this.getAndParse(ad.nextWrapperURL, options, (err, wrappedResponse) => {
        delete ad.nextWrapperURL;

        if (err != null) {
          // Timeout of VAST URI provided in Wrapper element, or of VAST URI provided in a subsequent Wrapper element.
          // (URI was either unavailable or reached a timeout as defined by the video player.)
          ad.errorCode = 301;
          ad.errorMessage = err.message;
          this.completeWrapperResolving(vastResponse, wrapperDepth, cb);
          return;
        }

        if (
          (wrappedResponse != null
            ? wrappedResponse.errorURLTemplates
            : undefined) != null
        ) {
          vastResponse.errorURLTemplates = vastResponse.errorURLTemplates.concat(
            wrappedResponse.errorURLTemplates
          );
        }

        if (wrappedResponse.ads.length === 0) {
          // No ads returned by the wrappedResponse, discard current <Ad><Wrapper> creatives
          ad.creatives = [];
        } else {
          let index = vastResponse.ads.indexOf(ad);
          vastResponse.ads.splice(index, 1);

          for (let wrappedAd of wrappedResponse.ads) {
            this.mergeWrapperAdData(wrappedAd, ad);
            vastResponse.ads.splice(++index, 0, wrappedAd);
          }
        }

        this.completeWrapperResolving(vastResponse, wrapperDepth, cb);
      });
    }

    this.completeWrapperResolving(vastResponse, wrapperDepth, cb);
  }

  completeWrapperResolving(vastResponse, wrapperDepth, cb) {
    for (let index = vastResponse.ads.length - 1; index >= 0; index--) {
      // Still some Wrappers URL to be resolved -> continue
      let ad = vastResponse.ads[index];
      if (ad.nextWrapperURL != null) {
        return;
      }
    }

    // We've to wait for all <Ad> elements to be parsed before handling error so we can:
    // - Send computed extensions data
    // - Ping all <Error> URIs defined across VAST files
    if (wrapperDepth === 0) {
      // No Ad case - The parser never bump into an <Ad> element
      if (vastResponse.ads.length === 0) {
        this.track(vastResponse.errorURLTemplates, { ERRORCODE: 303 });
      } else {
        for (let index = vastResponse.ads.length - 1; index >= 0; index--) {
          // - Error encountred while parsing
          // - No Creative case - The parser has dealt with soma <Ad><Wrapper> or/and an <Ad><Inline> elements
          // but no creative was found
          let ad = vastResponse.ads[index];
          if (ad.errorCode || ad.creatives.length === 0) {
            this.track(
              ad.errorURLTemplates.concat(vastResponse.errorURLTemplates),
              { ERRORCODE: ad.errorCode || 303 },
              { ERRORMESSAGE: ad.errorMessage || '' },
              { extensions: ad.extensions },
              { system: ad.system }
            );
            vastResponse.ads.splice(index, 1);
          }
        }
      }
    }

    cb(null, vastResponse);
  }

  mergeWrapperAdData(wrappedAd, ad) {
    wrappedAd.errorURLTemplates = ad.errorURLTemplates.concat(
      wrappedAd.errorURLTemplates
    );
    wrappedAd.impressionURLTemplates = ad.impressionURLTemplates.concat(
      wrappedAd.impressionURLTemplates
    );
    wrappedAd.extensions = ad.extensions.concat(wrappedAd.extensions);

    for (let creative of wrappedAd.creatives) {
      if (
        (ad.trackingEvents != null
          ? ad.trackingEvents[creative.type]
          : undefined) != null
      ) {
        for (let eventName in ad.trackingEvents[creative.type]) {
          const urls = ad.trackingEvents[creative.type][eventName];
          if (!creative.trackingEvents[eventName]) {
            creative.trackingEvents[eventName] = [];
          }
          creative.trackingEvents[eventName] = creative.trackingEvents[
            eventName
          ].concat(urls);
        }
      }
    }

    if (
      ad.videoClickTrackingURLTemplates != null
        ? ad.videoClickTrackingURLTemplates.length
        : undefined
    ) {
      for (let creative of wrappedAd.creatives) {
        if (creative.type === 'linear') {
          creative.videoClickTrackingURLTemplates = creative.videoClickTrackingURLTemplates.concat(
            ad.videoClickTrackingURLTemplates
          );
        }
      }
    }

    if (
      ad.videoCustomClickURLTemplates != null
        ? ad.videoCustomClickURLTemplates.length
        : undefined
    ) {
      for (let creative of wrappedAd.creatives) {
        if (creative.type === 'linear') {
          creative.videoCustomClickURLTemplates = creative.videoCustomClickURLTemplates.concat(
            ad.videoCustomClickURLTemplates
          );
        }
      }
    }

    // VAST 2.0 support - Use Wrapper/linear/clickThrough when Inline/Linear/clickThrough is null
    if (ad.videoClickThroughURLTemplate != null) {
      for (let creative of wrappedAd.creatives) {
        if (
          creative.type === 'linear' &&
          creative.videoClickThroughURLTemplate == null
        ) {
          creative.videoClickThroughURLTemplate =
            ad.videoClickThroughURLTemplate;
        }
      }
    }
  }
}
