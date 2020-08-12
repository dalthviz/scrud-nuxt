(function (global, factory) {
  if (typeof define === "function" && define.amd) {
    define(["exports"], factory);
  } else if (typeof exports !== "undefined") {
    factory(exports);
  } else {
    var mod = {
      exports: {}
    };
    factory(mod.exports);
    global.cachingClient = mod.exports;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function (_exports) {
  "use strict";

  Object.defineProperty(_exports, "__esModule", {
    value: true
  });
  _exports.default = void 0;

  function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

  function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

  function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

  // ----- Resources
  // * https://jasonwatmore.com/post/2020/04/18/fetch-a-lightweight-fetch-wrapper-to-simplify-http-requests
  // * https://github.com/GoogleChrome/samples/tree/gh-pages/service-worker/read-through-caching
  // * https://gist.github.com/niallo/3109252#gistcomment-2883309
  // * https://stackoverflow.com/a/58209729
  // Class definitions (CachingClient and EventDispatcher)
  // Needed for compatibility with Safari and Explorer since EventTarget there doesn't support the constructor.
  // Taken from: https://stackoverflow.com/a/58209729
  class EventDispatcher {
    constructor() {
      this._listeners = [];
    }

    hasEventListener(type, listener) {
      return this._listeners.some(item => item.type === type && item.listener === listener);
    }

    addEventListener(type, listener) {
      if (!this.hasEventListener(type, listener)) {
        this._listeners.push({
          type,
          listener,
          options: {
            once: false
          }
        });
      }

      return this;
    }

    removeEventListener(type, listener) {
      let index = this._listeners.findIndex(item => item.type === type && item.listener === listener);

      if (index >= 0) this._listeners.splice(index, 1);
      return this;
    }

    removeEventListeners() {
      this._listeners = [];
      return this;
    }

    dispatchEvent(evt) {
      this._listeners.filter(item => item.type === evt.type).forEach(item => {
        const {
          type,
          listener,
          options: {
            once
          }
        } = item;
        listener.call(this, evt);
        if (once === true) this.removeEventListener(type, listener);
      });

      return this;
    }

  }

  class CachingClient extends EventDispatcher {
    constructor(cacheVersion = 1, currentCache = 'read-through', jsonSchemaRelHeader = 'rel=\'describedBy\'', jsonSchemaEnvelopType = 'https://api.openteams.com/json-schema/Envelope') {
      super();

      _defineProperty(this, "clearUnknownCache", async () => {
        const expectedCacheNames = Object.keys(this.currentCaches).map(function (key) {
          return this.currentCaches[key];
        });
        const cacheNames = await caches.keys();
        return Promise.all(cacheNames.map(function (cacheName) {
          if (expectedCacheNames.indexOf(cacheName) === -1) {
            // If this cache name isn't present in the array of "expected" cache names, then delete it.
            // console.log('Deleting out of date cache:', cacheName);
            return caches.delete(cacheName);
          }
        }));
      });

      _defineProperty(this, "clearCache", async () => {
        return await caches.delete(this.currentCaches[this.currentCache]);
      });

      _defineProperty(this, "cacheRequest", async request => {
        const cache = await caches.open(this.currentCaches[this.currentCache]);
        const cachedResponse = await cache.match(request.url);

        if (cachedResponse) {
          // If there is an entry in the cache for request.url, then response will be defined
          // and we can just return it for now.
          // e.g do a HEAD request to check cache headers for the resource.
          // console.log(' Found response in cache:', cachedResponse);
          // TODO: Add a way to check if an update to the cache is needed
          const headResponse = await fetch(request.url, {
            method: this.HEAD
          });

          if (this._cacheUpToDate(headResponse, cachedResponse)) {
            return cachedResponse;
          }
        } // Otherwise, if there is no entry in the cache for request.url or it needs to be updated, response will be
        // undefined or old, and we need to fetch() the resource.
        // console.log(' No response for %s found in cache or response stored is old. ' + 'About to fetch from network...', request.url);
        // We call .clone() on the request since we might use it in the call to cache.put() later on.
        // Both fetch() and cache.put() "consume" the request, so we need to make a copy.
        // (see https://fetch.spec.whatwg.org/#dom-request-clone)


        const fetchResponse = await fetch(request.clone()); // console.log('  Response for %s from network is: %O', request.url, fetchResponse);
        // Optional: Add in extra conditions here, e.g. response.type == 'basic' to only cache
        // responses from the same domain. See https://fetch.spec.whatwg.org/#concept-response-type

        if (fetchResponse.status < 400) {
          // This avoids caching responses that we know are errors (i.e. HTTP status code of 4xx or 5xx).
          // One limitation is that, for non-CORS requests, we get back a filtered opaque response
          // (https://fetch.spec.whatwg.org/#concept-filtered-response-opaque) which will always have a
          // .status of 0, regardless of whether the underlying HTTP call was successful. Since we're
          // blindly caching those opaque responses, we run the risk of caching a transient error response.
          //
          // We need to call .clone() on the response object to save a copy of it to the cache.
          // (https://fetch.spec.whatwg.org/#dom-request-clone)
          const unwrappedResources = await this._getUnwrappedResources(fetchResponse.clone());

          if (unwrappedResources.length > 0) {
            this._cacheUnwrappedResources(unwrappedResources, fetchResponse, cache);
          }

          cache.put(request.url, fetchResponse.clone());

          if (!cachedResponse) {
            // Dispatch event informing of new info cached for the resource
            this.dispatchEvent(new CustomEvent(request.url));
          }
        } // Return the original response object, which will be used to fulfill the resource request.


        return fetchResponse;
      });

      _defineProperty(this, "_cacheUnwrappedResources", async (unwrappedResources, fetchResponse, cache) => {
        // Get Headers and content from response body, get response read-only values,
        // cache response content with the headers extracted and values found.
        for (const unwrappedResource of unwrappedResources) {
          const {
            ok,
            redirected,
            status,
            statusText
          } = fetchResponse;
          const {
            headers,
            body,
            url
          } = unwrappedResource;
          const cachedResponse = await cache.match(url);
          const unWrappedResponse = new Response(body, {
            headers,
            status,
            statusText,
            url
          }); // Set response read only values that aren't available in the Response constructor.

          Object.defineProperty(unWrappedResponse, 'url', {
            value: url
          });
          Object.defineProperty(unWrappedResponse, 'ok', {
            value: ok
          });
          Object.defineProperty(unWrappedResponse, 'redirected', {
            value: redirected
          }); // Check if an update is needed by looking the headers of the unwrapped resources and if an already cached response is found

          if (cachedResponse) {
            if (!this._cacheUpToDate(unWrappedResponse, cachedResponse)) {
              cache.put(url, unWrappedResponse); // Dispatch event informing of new info cached for a unwrapped resource

              this.dispatchEvent(new CustomEvent(url));
            }
          } else {
            cache.put(url, unWrappedResponse);
          }
        }
      });

      _defineProperty(this, "_getUnwrappedEnvelop", envelop => {
        const {
          etag,
          last_modified,
          url,
          content
        } = envelop;
        const headers = {
          ETag: etag,
          'Last-Modified': last_modified
        };
        return {
          headers,
          body: JSON.stringify(content),
          url
        };
      });

      _defineProperty(this, "_getUnwrappedResources", async response => {
        const responseLinks = this._parseLinkHeader(response.headers);

        const jsonSchemaURI = responseLinks[this.jsonSchemaRelHeader];
        const unwrappedResources = [];

        if (jsonSchemaURI && jsonSchemaURI !== response.url) {
          const schema = await this.get(jsonSchemaURI, {
            json: true
          });
          const schemaId = schema.$id;
          const schemaItems = schema.properties.content.properties.items;

          if (schemaId == this.jsonSchemaEnvelopType) {
            // Handle single resource
            unwrappedResources.push(this._getUnwrappedEnvelop(await response.json()));
            return unwrappedResources;
          } else if (schemaItems && schemaItems.$ref == this.jsonSchemaEnvelopType) {
            // Handle array of resources
            const content = await response.json();

            for (const envelop of content) {
              unwrappedResources.push(this._getUnwrappedEnvelop(envelop));
            }
          }
        }

        return unwrappedResources;
      });

      _defineProperty(this, "_cacheUpToDate", (response, cachedResponse) => {
        const headers = response.headers;
        const cacheResponseHeaders = cachedResponse.headers;
        const lastModifiedHeader = headers.get('Last-Modified');
        const eTagHeader = headers.get('ETag');
        const lastModifiedCacheHeader = cacheResponseHeaders.get('Last-Modified');
        const eTagCacheHeader = cacheResponseHeaders.get('ETag'); // TODO: Check if a better validation is needed

        return eTagCacheHeader != eTagHeader && lastModifiedCacheHeader != lastModifiedHeader;
      });

      _defineProperty(this, "_httpRequest", async (url, requestOptions) => {
        try {
          // TODO: Add logic to other types of request i.e PUT, DELETE
          const {
            method,
            callback,
            json
          } = requestOptions;

          if ((method == this.GET || method == this.POST) && callback) {
            console.log(callback);
            this.addEventListener(url, callback);
          }

          const response = await this.cacheRequest(new Request(url, requestOptions));
          return json ? await this._JSONhandleResponse(response) : response;
        } catch (err) {
          console.error('Error while catching the request', err);
        }
      });

      _defineProperty(this, "_parseLinkHeader", headers => {
        // Taken from: https://gist.github.com/niallo/3109252#gistcomment-2883309
        const header = headers.get('Link');

        if (!header || header.length === 0) {
          return {};
        } // Split parts by comma and parse each part into a named link


        const found = header.split(/(?!\B"[^"]*),(?![^"]*"\B)/).reduce((links, part) => {
          const section = part.split(/(?!\B"[^"]*);(?![^"]*"\B)/);

          if (section.length < 2) {
            throw new Error("Section could not be split on ';'");
          }

          const url = section[0].replace(/<(.*)>/, '$1').trim();
          const name = section[1].replace(/rel="(.*)"/, '$1').trim();
          links[name] = url;
          return links;
        }, {});
        return found;
      });

      _defineProperty(this, "_JSONhandleResponse", async response => {
        const text = await response.text();
        const data = text && JSON.parse(text);

        if (!response.ok) {
          const error = data && data.message || response.statusText;
          return Promise.reject(error);
        }

        return data;
      });

      _defineProperty(this, "get", async (url, options) => {
        const requestOptions = _objectSpread({
          method: this.GET
        }, options);

        return this._httpRequest(url, requestOptions);
      });

      _defineProperty(this, "options", async (url, options) => {
        const requestOptions = _objectSpread({
          method: this.OPTIONS
        }, options);

        return this._httpRequest(url, requestOptions);
      });

      _defineProperty(this, "post", async (url, body, options) => {
        const requestOptions = _objectSpread({
          method: this.POST,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }, options);

        return this._httpRequest(url, requestOptions);
      });

      _defineProperty(this, "put", async (url, body, options) => {
        const requestOptions = _objectSpread({
          method: this.PUT,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        }, options);

        return this._httpRequest(url, requestOptions);
      });

      _defineProperty(this, "delete", async (url, options) => {
        const requestOptions = _objectSpread({
          method: this.DELETE
        }, options);

        return this._httpRequest(url, requestOptions);
      });

      this.cacheVersion = cacheVersion;
      this.currentCache = currentCache;
      this.currentCaches = {};
      this.currentCaches[currentCache] = `${currentCache}-cache-v${cacheVersion}`;
      this.jsonSchemaRelHeader = jsonSchemaRelHeader;
      this.jsonSchemaEnvelopType = jsonSchemaEnvelopType;
    } // ----- Cache handling
    // Clears unhandled caches


  } // Export of the functions that should be available for external use.


  _defineProperty(CachingClient, "GET", 'GET');

  _defineProperty(CachingClient, "POST", 'POST');

  _defineProperty(CachingClient, "HEAD", 'HEAD');

  _defineProperty(CachingClient, "OPTIONS", 'OPTIONS');

  _defineProperty(CachingClient, "PUT", 'PUT');

  _defineProperty(CachingClient, "DELETE", 'DELETE');

  var _default = CachingClient;
  _exports.default = _default;
});