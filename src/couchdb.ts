import * as http from 'http';
import * as querystring from 'query-string';
import { AuthOptions } from 'request';
import * as request from 'request-promise';
import { CouchDbOptions, CouchDbResponse } from './index';

export class CouchDb {
    private host: string;
    private port: number;
    private auth: AuthOptions;
    private logging: boolean;

    public defaultDatabase: string;

    constructor(options: CouchDbOptions.Connection = {}) {
        this.host = options.host || 'http://127.0.0.1';
        this.port = options.port || 5984;
        this.logging = options.logging || false;
        this.defaultDatabase = options.defaultDatabase;

        /**
         * Need to make copy of options.auth because as of typescript 3
         * it will not be extensible, and the request library will
         * try and add a property to the passed in auth object.
         */
        if (options.auth) {
            try {
                this.auth = JSON.parse(JSON.stringify(options.auth));
            }
            catch {
                console.error('Error configuring Node CouchDB Client auth');
            }
        }
    }

    /**
     * This method with go through an create the query string used for
     * several methods
     * @return {String}
     */
    private createQueryString(queryObj: any = {}) {
        return Object.keys(queryObj).length ? `?${querystring.stringify(queryObj)}` : '';
    }

    /**
     * The default request options used with request
     * @return {Object}
     */
    private get defaultRequestOptions(): CouchDbOptions.RequestOptions {
        return {
            uri: `${this.host}:${this.port}`,
            auth: this.auth,
            method: 'GET',
            json: true,
            headers: {
                'user-agent': 'couchdb-promises',
                'accept': 'application/json'
            },
            resolveWithFullResponse: true
        };
    }

    /**
     * This method builds the request and returns the promise chain
     * @return {Promise<T>}
     */
    private request<T>(options: CouchDbOptions.RequestOptions = {}): PromiseLike<T> {
        const startTime = Date.now();
        const requestOptions = this.defaultRequestOptions;
        requestOptions.method = options.method || requestOptions.method;
        requestOptions.uri += `/${options.path}`;
        requestOptions.body = options.postData;

        if (options.headers && options.headers.length > 0) {
            requestOptions.headers = Object.assign({}, requestOptions.headers, options.headers);
        }

        return request(requestOptions as any).then(response => {
            if (this.logging) {
                // tslint:disable-next-line:no-console
                console.info({
                statusCode: response.statusCode,
                    message: this.statusCode(options.statusCodes, response.statusCode),
                    body: response.body,
                    duration: Date.now() - startTime
                });
            }
            return response.body;
        });
    }

    /**
     * Maps out the status to and custom status messages
     * @return {String}
     */
    private statusCode(statusCodes: { [key: number]: string }, status: number): string {
        const codes = Object.assign({}, http.STATUS_CODES, statusCodes);
        return codes[status] || 'unknown status';
    }

    /**
     * Get basic info on couchdb
     * @return {Promise}
     */
    getInfo() {
        return this.request<CouchDbResponse.Info>({
            statusCodes: {
                200: 'OK - Request completed successfully'
            }
        });
    }

    /***** DATABASE *****/

    /**
     * Get the list of all databases.
     * @return {Promise}
     */
    getDatabases() {
        return this.request<string[]>({
            path: '_all_dbs',
            statusCodes: {
                200: 'OK - Request completed successfully',
                401: 'Unauthorized - CouchDB Server Administrator privileges required',
            }
        });
    }

    /**
     * Get database
     * @param  {String} dbName
     * @return {Promise}
     */
    getDatabase(dbName?: string) {
        dbName = dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request<CouchDbResponse.DatabaseInfo>({
            path: encodeURIComponent(dbName),
            statusCodes: {
                200: 'OK - Request completed successfully',
                401: 'Unauthorized - CouchDB Server Administrator privileges required',
                404: 'Not Found – Requested database not found'
            }
        });
    }

    /**
     * Get database revision limit
     * @param  {String} dbName
     * @return {Promise}
     */
    getDatabaseRevisionLimit(dbName: string) {
        return this.request({
            path: `${encodeURIComponent(dbName)}/${encodeURIComponent('_revs_limit')}`,
            method: 'GET',
            statusCodes: {
                200: 'OK - Request completed successfully'
            }
        });
    }

    /**
     * Check if the database exists
     * @param  {String} dbName
     * @return {Promise}
     */
    checkDatabaseExists(dbName?: string) {
        dbName = dbName || this.defaultDatabase;
        if (!dbName) {
            throw new Error('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request({
            path: encodeURIComponent(dbName),
            method: 'HEAD',
            statusCodes: {
                200: 'OK - Database exists',
                401: 'Unauthorized - CouchDB Server Administrator privileges required',
                404: 'Not Found – Requested database not found'
            }
        }).then(response => {
            return true;
        }, error => {
            if (error && error.statusCode === 404) {
                return false;
            }
            throw error;
        });
    }

    /**
     * Create database
     * @param  {String} dbName
     * @return {Promise}
     */
    async createDatabase(dbName?: string, options?: {
        revisionLimit: number
    }) {
        dbName = dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        if (dbName !== '_users' && !dbName.match('^[a-z][a-z0-9_$()+/-]*$')) {
            return Promise.reject(`Invalid DB Name '${dbName}': http://docs.couchdb.org/en/latest/api/database/common.html#put--db`);
        }

        return this.request<CouchDbResponse.Generic>({
                path: encodeURIComponent(dbName),
                method: 'PUT',
                statusCodes: {
                    201: 'Created - Database created successfully',
                    400: 'Bad Request - Invalid database name',
                    401: 'Unauthorized - CouchDB Server Administrator privileges required',
                    412: 'Precondition Failed - Database already exists'
                }
            }).then(async response => {
                if (options && options.revisionLimit) {
                    await this.setDatabaseRevisionLimit(dbName, options.revisionLimit);
                }

                return response;
            }, error => {
                throw error;
            });
    }

    /**
     * Compact database
     * @param  {String} dbName
     * @return {Promise}
     */
    compactDatabase(dbName: string) {
        return this.request<CouchDbResponse.Generic>({
            path: `${encodeURIComponent(dbName)}/_compact`,
            method: 'POST',
            postData: {},
            statusCodes: {
                202: 'Accepted - Compaction request has been accepted',
                400: 'Bad Request - Invalid database name',
                401: 'Unauthorized - CouchDB Server Administrator privileges required',
                415: 'Unsupported Media Type - Bad Content-Type value'
            }
        })
    }

    /**
     * Set database revision limit
     * @param  {String} dbName
     * @param {Number} revisionLimit
     * @return {Promise}
     */
    setDatabaseRevisionLimit(dbName: string, revisionLimit: number) {
        return this.request<CouchDbResponse.Generic>({
            path: `${encodeURIComponent(dbName)}/_revs_limit`,
            method: 'PUT',
            postData: revisionLimit,
            statusCodes: {
                200: 'OK - Request completed successfully',
                400: 'Bad Request - Invalid JSON data'
            }
        });
    }

    /**
     * Delete database
     * @param  {String} dbName
     * @return {Promise}
     */
    deleteDatabase(dbName?: string) {
        dbName = dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request<CouchDbResponse.Generic>({
            path: encodeURIComponent(dbName),
            method: 'DELETE',
            statusCodes: {
                200: 'OK - Database removed successfully',
                400: 'Bad Request - Invalid database name or forgotten document id by accident',
                401: 'Unauthorized - CouchDB Server Administrator privileges required',
                404: 'Not Found - Database doesn’t exist'
            }
        });
    }

    /**
     * Update database security
     * @param  {String} dbName
     * @return {Promise}
     */
    updateDatabaseSecurity(options: {
        dbName?: string,
        admins: {
            names?: string[],
            roles?: string[]
        },
        members: {
            names?: string[],
            roles?: string[]
        }
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request<CouchDbResponse.Generic>({
            path: `${encodeURIComponent(dbName)}/_security`,
            method: 'PUT',
            postData: {
                admins: options.admins,
                members: options.members
            },
            statusCodes: {
                200: 'OK - Security updated',
                401: 'Unauthorized - CouchDB Server Administrator privileges required'
            }
        });
    }

    /***** USERS *****/

    /**
     * Create a new user
     * @param {{
     *         username: string;
     *         password: string;
     *         roles?: string[]
     *     }} options
     * @return {Promise}
     */
    createUser(options: {
        username: string;
        password: string;
        roles?: string[]
    }) {
        options.roles = options.roles || [];
        return this.request<CouchDbResponse.Create>({
            path: `_users`,
            method: 'POST',
            postData: {
                _id: `org.couchdb.user:${options.username}`,
                name: options.username,
                type: 'user',
                roles: [...options.roles],
                password: options.password
            },
            statusCodes: {
                201: 'Created New User',
                400: 'Bad Request - Invalid request',
                401: 'Unauthorized - CouchDB Server Administrator privileges required',
                500: 'Internal Server Error - Query execution error'
            }
        });
    }

    /**
     * Check if user exists
     * @param {{
     *         username: string;
     *         password: string;
     *         roles?: string[]
     *     }} options
     * @return {Promise}
     */
    checkUserExists(username: string) {
        const dbName = '_users';
        return  this.request({
            path: `${encodeURIComponent(dbName)}/org.couchdb.user:${username}`,
            method: 'HEAD',
            statusCodes: {
                200: 'OK - User exists',
                401: 'Unauthorized - Read privilege required',
                404: 'Not Found - User not found'
            }
        }).then(response => {
            return true;
        }, error => {
            if (error && error.statusCode === 404) {
                return false;
            }
            throw error;
        });
    }

    /**
     * Get User
     * @param  {String} dbName
     * @param  {String} docId
     * @param  {Object} [query]
     * @return {Promise}
     */
    getUser(username: string) {
        const dbName = '_users';
        const docId = `org.couchdb.user:${username}`;
        return this.request<CouchDbResponse.Document>({
            path: `${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}`,
            statusCodes: {
                200: 'OK - Request completed successfully',
                304: 'Not Modified - Document wasn’t modified since specified revision',
                400: 'Bad Request - The format of the request or revision was invalid',
                401: 'Unauthorized - Read privilege required',
                404: 'Not Found - Document not found'
            }
        });
    }

    /**
    * Update a user's password
    * @param {{
    *         username: string;
    *         password: string;
    *     }} options
    * @return {Promise}
    */
    async updateUserPassword(options: {
        username: string;
        password: string;
    }) {
        const user = await this.getUser(options.username);
        const dbName = '_users';

        return this.request<CouchDbResponse.Update>({
            path: `${encodeURIComponent(dbName)}/${user._id}`,
            method: 'PUT',
            postData: {
                _rev: user._rev,
                _id: user._id,
                name: user.name,
                type: 'user',
                roles: [...user.roles],
                password: options.password
            },
            statusCodes: {
                200: 'OK - User exists',
                401: 'Unauthorized - Read privilege required',
                404: 'Not Found - User not found',
                409: 'Document update conflict',
                500: 'Internal Server Error - Query execution error'
            }
        });
    }



    /***** DOCUMENTS *****/

    /**
     * Find documents (requires CouchDB >= 2.0.0)
     * @param  {String} dbName
     * @param  {Object} queryObj
     * @return {Promise}
     */
    findDocuments(options: {
        dbName?: string,
        findOptions: CouchDbOptions.FindOptions
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request<CouchDbResponse.Find>({
            path: `${encodeURIComponent(dbName)}/_find`,
            method: 'POST',
            postData: options.findOptions,
            statusCodes: {
                200: 'OK - Request completed successfully',
                400: 'Bad Request - Invalid request',
                401: 'Unauthorized - Read permission required',
                500: 'Internal Server Error - Query execution error'
            }
        });
    }

    /**
     * Get all documents
     * @param  {String} dbName
     * @param  {Object} [query]
     * @return {Promise}
     */
    getDocuments(options: {
        dbName?: string,
        options?: CouchDbOptions.FindAllOptions
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        const queryStr = this.createQueryString(options.options);
        return this.request<CouchDbResponse.AllDocuments>({
            path: `${encodeURIComponent(dbName)}/_all_docs${queryStr}`,
            statusCodes: {
                200: 'OK - Request completed successfully',
                401: 'Unauthorized - Read privilege required',
            }
        });
    }

    /**
     * Get Document
     * @param  {String} dbName
     * @param  {String} docId
     * @param  {Object} [query]
     * @return {Promise}
     */
    getDocument(options: {
        docId: string,
        dbName?: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request<CouchDbResponse.Document>({
            path: `${encodeURIComponent(dbName)}/${encodeURIComponent(options.docId)}`,
            statusCodes: {
                200: 'OK - Request completed successfully',
                304: 'Not Modified - Document wasn’t modified since specified revision',
                400: 'Bad Request - The format of the request or revision was invalid',
                401: 'Unauthorized - Read privilege required',
                404: 'Not Found - Document not found'
            }
        });
    }

    /**
     * Check if a document exists
     * @param  {String} dbName
     * @param  {String} docId
     * @return {Promise}
     */
    checkDocumentExists(options: {
        dbName?: string,
        docId: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request({
            path: `${encodeURIComponent(dbName)}/${encodeURIComponent(options.docId)}`,
            method: 'HEAD',
            statusCodes: {
                200: 'OK - Document exists',
                304: 'Not Modified - Document wasn’t modified since specified revision',
                401: 'Unauthorized - Read privilege required',
                404: 'Not Found - Document not found'
            }
        }).then(response => {
            return true;
        }, error => {
            if (error && error.statusCode === 404) {
                return false;
            }
            throw error;
        });
    }

    /**
     * Copy an existing document to a new document
     * @param  {String} dbName
     * @param  {String} docId
     * @param  {String} newDocId
     * @return {Promise}
     */
    copyDocument(options: {
        docId: string,
        newDocId: string,
        dbName?: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        if (options.docId && options.newDocId) {
            return this.request<CouchDbResponse.Create>({
                path: `${encodeURIComponent(dbName)}/${encodeURIComponent(options.docId)}`,
                method: 'COPY',
                headers: { Destination: options.newDocId },
                statusCodes: {
                    201: 'Created – Document created and stored on disk',
                    202: 'Accepted – Document data accepted, but not yet stored on disk',
                    400: 'Bad Request – Invalid request body or parameters',
                    401: 'Unauthorized – Write privileges required',
                    404: 'Not Found – Specified database or document ID doesn’t exists',
                    409: 'Conflict – Document with the specified ID already exists or specified revision is not latest for target document'
                }
            });
        }
        return Promise.reject('Invalid docId or newDocId');
    }

    /**
     * Create a new document or new revision of an existing document
     * @param  {String} dbName
     * @param  {Object} doc
     * @param  {String} [docId]
     * @return {Promise}
     */
    createDocument(options: {
        doc: any,
        docId?: string,
        dbName?: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        if (options.docId) {
            // create document by id (PUT)
            return this.request<CouchDbResponse.Create>({
                path: `${encodeURIComponent(dbName)}/${encodeURIComponent(options.docId)}`,
                method: 'PUT',
                postData: options.doc,
                headers: {
                    'content-type': 'application/json'
                },
                statusCodes: {
                    201: 'Created – Document created and stored on disk',
                    202: 'Accepted – Document data accepted, but not yet stored on disk',
                    400: 'Bad Request – Invalid request body or parameters',
                    401: 'Unauthorized – Write privileges required',
                    404: 'Not Found – Specified database or document ID doesn’t exists',
                    409: 'Conflict – Document with the specified ID already exists or specified revision is not latest for target document'
                }
            });
        }
        // create document without explicit id (POST)
        return this.request({
            path: encodeURIComponent(dbName),
            method: 'POST',
            postData: options.doc,
            statusCodes: {
                201: 'Created – Document created and stored on disk',
                202: 'Accepted – Document data accepted, but not yet stored on disk',
                400: 'Bad Request – Invalid database name',
                401: 'Unauthorized – Write privileges required',
                404: 'Not Found – Database doesn’t exists',
                409: 'Conflict – A Conflicting Document with same ID already exists'
            }
        });
    }

    /**
     * Create/Update documents in Bulk
     * @param  {String} dbName
     * @param  {Array} docs
     * @param  {Object} [opts]
     * @return {Promise}
     */
    upsertDocuments(options: {
        docs: any[],
        dbName?: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request<CouchDbResponse.Create[]>({
            path: `${encodeURIComponent(dbName)}/_bulk_docs`,
            method: 'POST',
            postData: {
                docs: options.docs
            },
            statusCodes: {
                201: 'Created – Document(s) have been created or updated',
                400: 'Bad Request – The request provided invalid JSON data',
                417: 'Expectation Failed – Occurs when all_or_nothing option set as true and at least one document was rejected by validation function',
                500: 'Internal Server Error – Malformed data provided, while it’s still valid JSON'
            }
        });
    }

    /**
     *  Updating a document
     *
     * @param {{
     *         dbName?: string;
     *         docId: string;
     *         rev: string;
     *         updatedDoc: any;
     *     }} options
     * @returns {Promise}
     * @memberof CouchDb
     */
    updateDocument(options: {
        dbName?: string;
        docId: string;
        rev: string;
        updatedDoc: any;
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request<CouchDbResponse.Create>({
            path: `${encodeURIComponent(dbName)}/${encodeURIComponent(options.docId)}`,
            method: 'PUT',
            headers: {
                'If-Match': options.rev
            },
            postData: options.updatedDoc,
            statusCodes: {
                201: 'Updated – Document(s) have been updated',
                400: 'Bad Request – The request provided invalid JSON data',
                409: 'Document Conflict',
                417: 'Expectation Failed – Occurs when all_or_nothing option set as true and at least one document was rejected by validation function',
                500: 'Internal Server Error – Malformed data provided, while it’s still valid JSON'
            }
        });
    }

    /**
     * Delete a named document
     * @param  {String} dbName
     * @param  {String} docId
     * @param  {String} rev
     * @return {Promise}
     */
    deleteDocument(options: {
        dbName?: string,
        docId: string,
        rev: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request<CouchDbResponse.Generic>({
            path: `${encodeURIComponent(dbName)}/${encodeURIComponent(options.docId)}?rev=${options.rev}`,
            method: 'DELETE',
            statusCodes: {
                200: 'OK - Document successfully removed',
                202: 'Accepted - Request was accepted, but changes are not yet stored on disk',
                400: 'Bad Request - Invalid request body or parameters',
                401: 'Unauthorized - Write privilege required',
                404: 'Not Found - Specified database or document ID doesn\'t exist',
                409: 'Conflict - Specified revision is not the latest for target document'
            }
        });
    }

    /***** UTILS *****/

    /**
     * Get one or more UUIDs
     * @param  {Number} [count = 1]
     * @return {Promise}
     */
    getUuids(count: number = 1) {
        return this.request<string[]>({
            path: `_uuids?count=${count}`,
            statusCodes: {
                200: 'OK - Request completed successfully',
                403: 'Forbidden – Requested more UUIDs than is allowed to retrieve'
            }
        });
    }

    /***** DESIGN DOCUMENTS *****/

    /**
     * Get design document
     * @param  {String} dbName
     * @param  {String} docId
     * @param  {Object} [query]
     * @return {Promise}
     */
    getDesignDocument(options: {
        dbName?: string,
        docId: string,
        options?: CouchDbOptions.DocumentOptions
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        const queryStr = this.createQueryString(options.options);
        return this.request({
            path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(options.docId)}${queryStr}`,
            statusCodes: {
                200: 'OK - Request completed successfully',
                304: 'Not Modified - Document wasn’t modified since specified revision',
                400: 'Bad Request - The format of the request or revision was invalid',
                401: 'Unauthorized - Read privilege required',
                404: 'Not Found - Document not found'
            }
        });
    }

    /**
     * Get design document info
     * @param  {String} dbName
     * @param  {String} docId
     * @return {Promise}
     */
    getDesignDocumentInfo(options: {
        dbName: string,
        docId: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request({
            path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(options.docId)}/_info`,
            statusCodes: {
                200: 'OK - Request completed successfully'
            }
        });
    }

    /**
     * Create a new design document or new revision of an existing design document
     * @param  {String} dbName
     * @param  {Object} doc
     * @param  {String} docId
     * @return {Promise}
     */
    createDesignDocument(options: {
        dbName?: string,
        doc: any,
        docId: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request({
            path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(options.docId)}`,
            method: 'PUT',
            postData: options.doc,
            statusCodes: {
                201: 'Created – Document created and stored on disk',
                202: 'Accepted – Document data accepted, but not yet stored on disk',
                400: 'Bad Request – Invalid request body or parameters',
                401: 'Unauthorized – Write privileges required',
                404: 'Not Found – Specified database or document ID doesn’t exists',
                409: 'Conflict – Document with the specified ID already exists or specified revision is not latest for target document'
            }
        });
    }

    /**
     * Delete a named design document
     * @param  {String} dbName
     * @param  {String} docId
     * @param  {String} rev
     * @return {Promise}
     */
    deleteDesignDocument(options: {
        dbName?: string,
        docId: string,
        rev: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request({
            path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(options.docId)}?rev=${options.rev}`,
            method: 'DELETE',
            statusCodes: {
                200: 'OK - Document successfully removed',
                202: 'Accepted - Request was accepted, but changes are not yet stored on disk',
                400: 'Bad Request - Invalid request body or parameters',
                401: 'Unauthorized - Write privilege required',
                404: 'Not Found - Specified database or document ID doesn\'t exist',
                409: 'Conflict - Specified revision is not the latest for target document'
            }
        });
    }

    /**
     * Get view
     * @param  {String} dbName
     * @param  {String} docId
     * @param  {String} viewName
     * @param  {Object} [query]
     * @return {Promise}
     */
    getDocumentView(options: {
        dbName?: string,
        docId: string,
        viewName: string,
        options?: CouchDbOptions.DocumentOptions
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        const queryStr = this.createQueryString(options.options);
        return this.request({
            path: `${encodeURIComponent(dbName)}/_design/${encodeURIComponent(options.docId)}/_view/${encodeURIComponent(options.viewName)}${queryStr}`,
            statusCodes: {
                200: 'OK - Request completed successfully'
            }
        });
    }

    /***** INDEX *****/

    /**
     * gets all the indexes in the db (requires CouchDB >= 2.0.0)
     * @param  {String} dbName
     * @return {Promise}
     */
    getIndexes(dbName?: string) {
        dbName = dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request({
            path: `${encodeURIComponent(dbName)}/_index`,
            method: 'GET',
            statusCodes: {
                200: 'OK - Success',
                400: 'Bad Request - Invalid request',
                401: 'Unauthorized - Read permission required',
                500: 'Internal Server Error - Execution error'
            }
        });
    }

    /**
     * create index (requires CouchDB >= 2.0.0)
     * @param  {String} dbName
     * @param  {Object} queryObj
     * @return {Promise}
     */
    createIndex(options: {
        dbName?: string,
        index: any,
        name?: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request({
            path: `${encodeURIComponent(dbName)}/_index`,
            method: 'POST',
            postData: {
                index: options.index,
                name: options.name
            },
            statusCodes: {
                200: 'OK - Index created successfully or already exists',
                400: 'Bad Request - Invalid request',
                401: 'Unauthorized - Admin permission required',
                500: 'Internal Server Error - Execution error'
            }
        });
    }

    /**
     * delete index (requires CouchDB >= 2.0.0)
     * @param  {String} dbName
     * @param  {String} docId - design document id
     * @param  {String} name - index name
     * @return {Promise}
     */
    deleteIndex(options: {
        dbName?: string,
        docId: string,
        indexName: string
    }) {
        const dbName = options.dbName || this.defaultDatabase;
        if (!dbName) {
            return Promise.reject('No DB specified. Set defaultDatabase or specify one');
        }
        return this.request({
            path: `${encodeURIComponent(dbName)}/_index/${encodeURIComponent(options.docId)}/json/${encodeURIComponent(options.indexName)}`,
            method: 'DELETE',
            statusCodes: {
                200: 'OK - Success',
                400: 'Bad Request - Invalid request',
                401: 'Unauthorized - Writer permission required',
                404: 'Not Found - Index not found',
                500: 'Internal Server Error - Execution error'
            }
        });
    }
}
