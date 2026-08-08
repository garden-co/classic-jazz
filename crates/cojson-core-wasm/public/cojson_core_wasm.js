import { dumpWasmPanic } from './snippets/cojson-core-wasm-130f84f2109aae70/inline0.js';

let wasm;

let WASM_VECTOR_LEN = 0;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_export_4.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(wasm.__wbindgen_export_4.get(mem.getUint32(i, true)));
    }
    wasm.__externref_drop_slice(ptr, len);
    return result;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_4.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedUint32ArrayMemory0 = null;

function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

export function init() {
    wasm.init();
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}
/**
 * WASM-exposed function to verify an Ed25519 signature.
 * - `verifying_key`: 32 bytes of verifying key material
 * - `message`: Raw bytes that were signed
 * - `signature`: 64 bytes of signature material
 * Returns true if signature is valid, false otherwise, or throws JsError if verification fails.
 * @param {Uint8Array} verifying_key
 * @param {Uint8Array} message
 * @param {Uint8Array} signature
 * @returns {boolean}
 */
export function ed25519Verify(verifying_key, message, signature) {
    const ptr0 = passArray8ToWasm0(verifying_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.ed25519Verify(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
/**
 * WASM-exposed function to sign a message with an Ed25519 signing key.
 * - `signing_key`: 32 bytes of signing key material
 * - `message`: Raw bytes to sign
 * Returns 64 bytes of signature material or throws JsError if signing fails.
 * @param {Uint8Array} signing_key
 * @param {Uint8Array} message
 * @returns {Uint8Array}
 */
export function ed25519SigningKeySign(signing_key, message) {
    const ptr0 = passArray8ToWasm0(signing_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ed25519SigningKeySign(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * WASM-exposed function to validate and copy Ed25519 signing key bytes.
 * - `bytes`: 32 bytes of signing key material to validate
 * Returns the same 32 bytes if valid or throws JsError if invalid.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function ed25519SigningKeyFromBytes(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ed25519SigningKeyFromBytes(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * WASM-exposed function to sign a message using Ed25519.
 * - `signing_key`: 32 bytes of signing key material
 * - `message`: Raw bytes to sign
 * Returns 64 bytes of signature material or throws JsError if signing fails.
 * @param {Uint8Array} signing_key
 * @param {Uint8Array} message
 * @returns {Uint8Array}
 */
export function ed25519Sign(signing_key, message) {
    const ptr0 = passArray8ToWasm0(signing_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.ed25519Sign(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * WASM-exposed function to validate and copy Ed25519 signature bytes.
 * - `bytes`: 64 bytes of signature material to validate
 * Returns the same 64 bytes if valid or throws JsError if invalid.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function ed25519SignatureFromBytes(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ed25519SignatureFromBytes(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * WASM-exposed function to validate and copy Ed25519 verifying key bytes.
 * - `bytes`: 32 bytes of verifying key material to validate
 * Returns the same 32 bytes if valid or throws JsError if invalid.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function ed25519VerifyingKeyFromBytes(bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ed25519VerifyingKeyFromBytes(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Generate a new Ed25519 signing key using secure random number generation.
 * Returns 32 bytes of raw key material suitable for use with other Ed25519 functions.
 * @returns {Uint8Array}
 */
export function newEd25519SigningKey() {
    const ret = wasm.newEd25519SigningKey();
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * WASM-exposed function to derive the public key from an Ed25519 signing key.
 * - `signing_key`: 32 bytes of signing key material
 * Returns 32 bytes of public key material or throws JsError if key is invalid.
 * @param {Uint8Array} signing_key
 * @returns {Uint8Array}
 */
export function ed25519SigningKeyToPublic(signing_key) {
    const ptr0 = passArray8ToWasm0(signing_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ed25519SigningKeyToPublic(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * WASM-exposed function to derive an Ed25519 verifying key from a signing key.
 * - `signing_key`: 32 bytes of signing key material
 * Returns 32 bytes of verifying key material or throws JsError if key is invalid.
 * @param {Uint8Array} signing_key
 * @returns {Uint8Array}
 */
export function ed25519VerifyingKey(signing_key) {
    const ptr0 = passArray8ToWasm0(signing_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ed25519VerifyingKey(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * WASM-exposed function for unsealing a message using X25519 + XSalsa20-Poly1305.
 * Provides authenticated decryption with perfect forward secrecy.
 * - `sealed_message`: The sealed bytes to decrypt
 * - `recipient_secret`: Base58-encoded recipient's private key with "sealerSecret_z" prefix
 * - `sender_id`: Base58-encoded sender's public key with "sealer_z" prefix
 * - `nonce_material`: Raw bytes used to generate the nonce (must match sealing)
 * Returns unsealed bytes or throws JsError if unsealing fails.
 * @param {Uint8Array} sealed_message
 * @param {string} recipient_secret
 * @param {string} sender_id
 * @param {Uint8Array} nonce_material
 * @returns {Uint8Array}
 */
export function unseal(sealed_message, recipient_secret, sender_id, nonce_material) {
    const ptr0 = passArray8ToWasm0(sealed_message, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(recipient_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(sender_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(nonce_material, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.unseal(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}

/**
 * WASM-exposed function for sealing a message for a group (anonymous box pattern).
 * Uses an ephemeral key pair, so no sender authentication is provided.
 * - `message`: Raw bytes to seal
 * - `recipient_id`: Base58-encoded recipient's public key with "sealer_z" prefix (the group's sealer)
 * - `nonce_material`: Raw bytes used to generate the nonce
 * Returns ephemeral_public_key (32 bytes) || ciphertext, or throws JsError if sealing fails.
 * @param {Uint8Array} message
 * @param {string} recipient_id
 * @param {Uint8Array} nonce_material
 * @returns {Uint8Array}
 */
export function sealForGroup(message, recipient_id, nonce_material) {
    const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(recipient_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(nonce_material, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.sealForGroup(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * WASM-exposed function for sealing a message using X25519 + XSalsa20-Poly1305.
 * Provides authenticated encryption with perfect forward secrecy.
 * - `message`: Raw bytes to seal
 * - `sender_secret`: Base58-encoded sender's private key with "sealerSecret_z" prefix
 * - `recipient_id`: Base58-encoded recipient's public key with "sealer_z" prefix
 * - `nonce_material`: Raw bytes used to generate the nonce
 * Returns sealed bytes or throws JsError if sealing fails.
 * @param {Uint8Array} message
 * @param {string} sender_secret
 * @param {string} recipient_id
 * @param {Uint8Array} nonce_material
 * @returns {Uint8Array}
 */
export function seal(message, sender_secret, recipient_id, nonce_material) {
    const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(sender_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(recipient_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray8ToWasm0(nonce_material, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.seal(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v5;
}

/**
 * WASM-exposed function for unsealing a message sealed for a group (anonymous box pattern).
 * Extracts the ephemeral public key and decrypts the message.
 * - `sealed_message`: ephemeral_public_key (32 bytes) || ciphertext
 * - `recipient_secret`: Base58-encoded recipient's private key with "sealerSecret_z" prefix
 * - `nonce_material`: Raw bytes used to generate the nonce (must match sealing)
 * Returns unsealed bytes or throws JsError if unsealing fails.
 * @param {Uint8Array} sealed_message
 * @param {string} recipient_secret
 * @param {Uint8Array} nonce_material
 * @returns {Uint8Array}
 */
export function unsealForGroup(sealed_message, recipient_secret, nonce_material) {
    const ptr0 = passArray8ToWasm0(sealed_message, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(recipient_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(nonce_material, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.unsealForGroup(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * WASM-exposed function to derive a sealer ID from a sealer secret.
 * - `secret`: Raw bytes of the sealer secret
 * Returns a base58-encoded sealer ID with "sealer_z" prefix or throws JsError if derivation fails.
 * @param {Uint8Array} secret
 * @returns {string}
 */
export function getSealerId(secret) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.getSealerId(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Generate a new X25519 private key using secure random number generation.
 * Returns 32 bytes of raw key material suitable for use with other X25519 functions.
 * This key can be reused for multiple Diffie-Hellman exchanges.
 * @returns {Uint8Array}
 */
export function newX25519PrivateKey() {
    const ret = wasm.newX25519PrivateKey();
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}

/**
 * WASM-exposed function to derive an X25519 public key from a private key.
 * - `private_key`: 32 bytes of private key material
 * Returns 32 bytes of public key material or throws JsError if key is invalid.
 * @param {Uint8Array} private_key
 * @returns {Uint8Array}
 */
export function x25519PublicKey(private_key) {
    const ptr0 = passArray8ToWasm0(private_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.x25519PublicKey(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * WASM-exposed function to perform X25519 Diffie-Hellman key exchange.
 * - `private_key`: 32 bytes of private key material
 * - `public_key`: 32 bytes of public key material
 * Returns 32 bytes of shared secret material or throws JsError if key exchange fails.
 * @param {Uint8Array} private_key
 * @param {Uint8Array} public_key
 * @returns {Uint8Array}
 */
export function x25519DiffieHellman(private_key, public_key) {
    const ptr0 = passArray8ToWasm0(private_key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(public_key, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.x25519DiffieHellman(ptr0, len0, ptr1, len1);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * WASM-exposed function to encrypt bytes with a key secret and nonce material.
 * - `value`: The raw bytes to encrypt
 * - `key_secret`: A base58-encoded key secret with "keySecret_z" prefix
 * - `nonce_material`: Raw bytes used to generate the nonce
 * Returns the encrypted bytes or throws a JsError if encryption fails.
 * @param {Uint8Array} value
 * @param {string} key_secret
 * @param {Uint8Array} nonce_material
 * @returns {Uint8Array}
 */
export function encrypt(value, key_secret, nonce_material) {
    const ptr0 = passArray8ToWasm0(value, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(key_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(nonce_material, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.encrypt(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * WASM-exposed function to decrypt bytes with a key secret and nonce material.
 * - `ciphertext`: The encrypted bytes to decrypt
 * - `key_secret`: A base58-encoded key secret with "keySecret_z" prefix
 * - `nonce_material`: Raw bytes used to generate the nonce (must match encryption)
 * Returns the decrypted bytes or throws a JsError if decryption fails.
 * @param {Uint8Array} ciphertext
 * @param {string} key_secret
 * @param {Uint8Array} nonce_material
 * @returns {Uint8Array}
 */
export function decrypt(ciphertext, key_secret, nonce_material) {
    const ptr0 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(key_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(nonce_material, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.decrypt(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * WASM-exposed function for XSalsa20 decryption without authentication.
 * - `key`: 32-byte key for decryption (must match encryption key)
 * - `nonce_material`: Raw bytes used to generate a 24-byte nonce (must match encryption)
 * - `ciphertext`: Encrypted bytes to decrypt
 * Returns the decrypted bytes or throws a JsError if decryption fails.
 * Note: This function does not provide authentication. Use decrypt_xsalsa20_poly1305 for authenticated decryption.
 * @param {Uint8Array} key
 * @param {Uint8Array} nonce_material
 * @param {Uint8Array} ciphertext
 * @returns {Uint8Array}
 */
export function decryptXsalsa20(key, nonce_material, ciphertext) {
    const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(nonce_material, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(ciphertext, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.decryptXsalsa20(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * WASM-exposed function for XSalsa20 encryption without authentication.
 * - `key`: 32-byte key for encryption
 * - `nonce_material`: Raw bytes used to generate a 24-byte nonce via BLAKE3
 * - `plaintext`: Raw bytes to encrypt
 * Returns the encrypted bytes or throws a JsError if encryption fails.
 * Note: This function does not provide authentication. Use encrypt_xsalsa20_poly1305 for authenticated encryption.
 * @param {Uint8Array} key
 * @param {Uint8Array} nonce_material
 * @param {Uint8Array} plaintext
 * @returns {Uint8Array}
 */
export function encryptXsalsa20(key, nonce_material, plaintext) {
    const ptr0 = passArray8ToWasm0(key, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(nonce_material, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(plaintext, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.encryptXsalsa20(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}

/**
 * WASM-exposed function to sign a message using Ed25519.
 * - `message`: Raw bytes to sign
 * - `secret`: Raw Ed25519 signing key bytes
 * Returns base58-encoded signature with "signature_z" prefix or throws JsError if signing fails.
 * @param {Uint8Array} message
 * @param {Uint8Array} secret
 * @returns {string}
 */
export function sign(message, secret) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sign(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * WASM-exposed function to derive a signer ID from a signing key.
 * - `secret`: Raw Ed25519 signing key bytes
 * Returns base58-encoded verifying key with "signer_z" prefix or throws JsError if derivation fails.
 * @param {Uint8Array} secret
 * @returns {string}
 */
export function getSignerId(secret) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passArray8ToWasm0(secret, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.getSignerId(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * WASM-exposed function to verify an Ed25519 signature.
 * - `signature`: Raw signature bytes
 * - `message`: Raw bytes that were signed
 * - `id`: Raw Ed25519 verifying key bytes
 * Returns true if signature is valid, false otherwise, or throws JsError if verification fails.
 * @param {Uint8Array} signature
 * @param {Uint8Array} message
 * @param {Uint8Array} id
 * @returns {boolean}
 */
export function verify(signature, message, id) {
    const ptr0 = passArray8ToWasm0(signature, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(message, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(id, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.verify(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Hash data once using BLAKE3.
 * - `data`: Raw bytes to hash
 * Returns 32 bytes of hash output.
 * This is the simplest way to compute a BLAKE3 hash of a single piece of data.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function blake3HashOnce(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.blake3HashOnce(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Generate a 24-byte nonce from input material using BLAKE3.
 * - `nonce_material`: Raw bytes to derive the nonce from
 * Returns 24 bytes suitable for use as a nonce in cryptographic operations.
 * This function is deterministic - the same input will produce the same nonce.
 * @param {Uint8Array} nonce_material
 * @returns {Uint8Array}
 */
export function generateNonce(nonce_material) {
    const ptr0 = passArray8ToWasm0(nonce_material, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.generateNonce(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Compute a short hash of a stable-stringified JSON value.
 * The input should already be serialized using stableStringify on the JS side.
 * Returns a string prefixed with "shortHash_z" followed by base58-encoded hash.
 * @param {string} value
 * @returns {string}
 */
export function shortHash(value) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(value, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.shortHash(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Hash data once using BLAKE3 with a context prefix.
 * - `data`: Raw bytes to hash
 * - `context`: Context bytes to prefix to the data
 * Returns 32 bytes of hash output.
 * This is useful for domain separation - the same data hashed with different contexts will produce different outputs.
 * @param {Uint8Array} data
 * @param {Uint8Array} context
 * @returns {Uint8Array}
 */
export function blake3HashOnceWithContext(data, context) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(context, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.blake3HashOnceWithContext(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

const Blake3HasherFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_blake3hasher_free(ptr >>> 0, 1));

export class Blake3Hasher {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(Blake3Hasher.prototype);
        obj.__wbg_ptr = ptr;
        Blake3HasherFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Blake3HasherFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_blake3hasher_free(ptr, 0);
    }
    constructor() {
        const ret = wasm.blake3hasher_new();
        this.__wbg_ptr = ret >>> 0;
        Blake3HasherFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {Blake3Hasher}
     */
    clone() {
        const ret = wasm.blake3hasher_clone(this.__wbg_ptr);
        return Blake3Hasher.__wrap(ret);
    }
    /**
     * @param {Uint8Array} data
     */
    update(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.blake3hasher_update(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * @returns {Uint8Array}
     */
    finalize() {
        const ret = wasm.blake3hasher_finalize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}

const SessionMapFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_sessionmap_free(ptr >>> 0, 1));

export class SessionMap {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SessionMapFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_sessionmap_free(ptr, 0);
    }
    /**
     * Get the header as JSON
     * @returns {string}
     */
    getHeader() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.sessionmap_getHeader(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Check if this CoValue is deleted
     * @returns {boolean}
     */
    isDeleted() {
        const ret = wasm.sessionmap_isDeleted(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check whether the CoValue still has pending streaming content.
     * @returns {boolean}
     */
    isStreaming() {
        const ret = wasm.sessionmap_isStreaming(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get the known state as a native JavaScript object
     * @returns {any}
     */
    getKnownState() {
        const ret = wasm.sessionmap_getKnownState(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get all session IDs as native array
     * @returns {string[]}
     */
    getSessionIds() {
        const ret = wasm.sessionmap_getSessionIds(this.__wbg_ptr);
        var v1 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Get single transaction by index as JSON string (returns undefined if not found)
     * @param {string} session_id
     * @param {number} tx_index
     * @returns {string | undefined}
     */
    getTransaction(session_id, tx_index) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_getTransaction(this.__wbg_ptr, ptr0, len0, tx_index);
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * Mark this CoValue as deleted
     */
    markAsDeleted() {
        wasm.sessionmap_markAsDeleted(this.__wbg_ptr);
    }
    /**
     * Add transactions to a session
     * @param {string} session_id
     * @param {string | null | undefined} signer_id
     * @param {string} transactions_json
     * @param {string} signature
     * @param {boolean} skip_verify
     */
    addTransactions(session_id, signer_id, transactions_json, signature, skip_verify) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(signer_id) ? 0 : passStringToWasm0(signer_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(transactions_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(signature, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_addTransactions(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, skip_verify);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Get last signature for a session (returns undefined if session not found)
     * @param {string} session_id
     * @returns {string | undefined}
     */
    getLastSignature(session_id) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_getLastSignature(this.__wbg_ptr, ptr0, len0);
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * Decrypt transaction changes
     * @param {string} session_id
     * @param {number} tx_index
     * @param {string} key_secret
     * @returns {string | undefined}
     */
    decryptTransaction(session_id, tx_index, key_secret) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(key_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_decryptTransaction(this.__wbg_ptr, ptr0, len0, tx_index, ptr1, len1);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v3;
        if (ret[0] !== 0) {
            v3 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v3;
    }
    /**
     * Get signature after specific transaction index
     * @param {string} session_id
     * @param {number} tx_index
     * @returns {string | undefined}
     */
    getSignatureAfter(session_id, tx_index) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_getSignatureAfter(this.__wbg_ptr, ptr0, len0, tx_index);
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * Decrypt many transactions in one call. `indices` is a `Uint32Array`.
     * Returns a JSON array string (element `i` is the decrypted changes of
     * `indices[i]`, or `null` if that tx could not be decrypted), or
     * `undefined` if the session does not exist.
     * @param {string} session_id
     * @param {Uint32Array} indices
     * @param {string} key_secret
     * @returns {string | undefined}
     */
    decryptTransactions(session_id, indices, key_secret) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(key_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_decryptTransactions(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
        let v4;
        if (ret[0] !== 0) {
            v4 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v4;
    }
    /**
     * Get transaction count for a session (returns -1 if session not found)
     * @param {string} session_id
     * @returns {number}
     */
    getTransactionCount(session_id) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_getTransactionCount(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Decrypt transaction meta
     * @param {string} session_id
     * @param {number} tx_index
     * @param {string} key_secret
     * @returns {string | undefined}
     */
    decryptTransactionMeta(session_id, tx_index, key_secret) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(key_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_decryptTransactionMeta(this.__wbg_ptr, ptr0, len0, tx_index, ptr1, len1);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v3;
        if (ret[0] !== 0) {
            v3 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v3;
    }
    /**
     * Get transactions for a session from index as JSON strings (returns undefined if session not found)
     * @param {string} session_id
     * @param {number} from_index
     * @returns {string[] | undefined}
     */
    getSessionTransactions(session_id, from_index) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_getSessionTransactions(this.__wbg_ptr, ptr0, len0, from_index);
        let v2;
        if (ret[0] !== 0) {
            v2 = getArrayJsValueFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        }
        return v2;
    }
    /**
     * Set streaming known state
     * @param {string} streaming_json
     */
    setStreamingKnownState(streaming_json) {
        const ptr0 = passStringToWasm0(streaming_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_setStreamingKnownState(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Create new private transaction (for local writes)
     * Returns JSON: { signature: string, transaction: Transaction }
     * @param {string} session_id
     * @param {string} signer_secret
     * @param {string} changes_json
     * @param {string} key_id
     * @param {string} key_secret
     * @param {string | null | undefined} meta_json
     * @param {number} made_at
     * @returns {string}
     */
    makeNewPrivateTransaction(session_id, signer_secret, changes_json, key_id, key_secret, meta_json, made_at) {
        let deferred8_0;
        let deferred8_1;
        try {
            const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(signer_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(changes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passStringToWasm0(key_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passStringToWasm0(key_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len4 = WASM_VECTOR_LEN;
            var ptr5 = isLikeNone(meta_json) ? 0 : passStringToWasm0(meta_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len5 = WASM_VECTOR_LEN;
            const ret = wasm.sessionmap_makeNewPrivateTransaction(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, made_at);
            var ptr7 = ret[0];
            var len7 = ret[1];
            if (ret[3]) {
                ptr7 = 0; len7 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred8_0 = ptr7;
            deferred8_1 = len7;
            return getStringFromWasm0(ptr7, len7);
        } finally {
            wasm.__wbindgen_free(deferred8_0, deferred8_1, 1);
        }
    }
    /**
     * Get the last signature checkpoint index (-1 if no checkpoints, undefined if session not found)
     * @param {string} session_id
     * @returns {number | undefined}
     */
    getLastSignatureCheckpoint(session_id) {
        const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_getLastSignatureCheckpoint(this.__wbg_ptr, ptr0, len0);
        return ret === 0x100000001 ? undefined : ret;
    }
    /**
     * Create new trusting transaction (for local writes)
     * Returns JSON: { signature: string, transaction: Transaction }
     * @param {string} session_id
     * @param {string} signer_secret
     * @param {string} changes_json
     * @param {string | null | undefined} meta_json
     * @param {number} made_at
     * @returns {string}
     */
    makeNewTrustingTransaction(session_id, signer_secret, changes_json, meta_json, made_at) {
        let deferred6_0;
        let deferred6_1;
        try {
            const ptr0 = passStringToWasm0(session_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(signer_secret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(changes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            var ptr3 = isLikeNone(meta_json) ? 0 : passStringToWasm0(meta_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len3 = WASM_VECTOR_LEN;
            const ret = wasm.sessionmap_makeNewTrustingTransaction(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, made_at);
            var ptr5 = ret[0];
            var len5 = ret[1];
            if (ret[3]) {
                ptr5 = 0; len5 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred6_0 = ptr5;
            deferred6_1 = len5;
            return getStringFromWasm0(ptr5, len5);
        } finally {
            wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
        }
    }
    /**
     * Get the known state with streaming as a native JavaScript object
     * @returns {any}
     */
    getKnownStateWithStreaming() {
        const ret = wasm.sessionmap_getKnownStateWithStreaming(this.__wbg_ptr);
        return ret;
    }
    /**
     * Create a new SessionMap for a CoValue
     * `max_tx_size` is the threshold for recording in-between signatures (default: 100KB)
     * Create a new SessionMap for a CoValue.
     * Validates the header and verifies that `co_id` matches the hash of the header.
     * `max_tx_size` is the threshold for recording in-between signatures (default: 100KB)
     * `skip_verify` if true, skips uniqueness and ID validation (for trusted storage shards)
     * @param {string} co_id
     * @param {string} header_json
     * @param {number | null} [max_tx_size]
     * @param {boolean | null} [skip_verify]
     */
    constructor(co_id, header_json, max_tx_size, skip_verify) {
        const ptr0 = passStringToWasm0(co_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(header_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.sessionmap_new(ptr0, len0, ptr1, len1, isLikeNone(max_tx_size) ? 0x100000001 : (max_tx_size) >>> 0, isLikeNone(skip_verify) ? 0xFFFFFF : skip_verify ? 1 : 0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        SessionMapFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_String_8f0eb39a4a4c2f66 = function(arg0, arg1) {
        const ret = String(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_buffer_609cc3eee51ed158 = function(arg0) {
        const ret = arg0.buffer;
        return ret;
    };
    imports.wbg.__wbg_call_672a4d21634d4a24 = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_call_7cccdd69e0791ae2 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.call(arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_crypto_574e78ad8b13b65f = function(arg0) {
        const ret = arg0.crypto;
        return ret;
    };
    imports.wbg.__wbg_dumpWasmPanic_a39b8272e193aa3d = function(arg0, arg1) {
        dumpWasmPanic(getStringFromWasm0(arg0, arg1));
    };
    imports.wbg.__wbg_error_7534b8e9a36f1ab4 = function(arg0, arg1) {
        let deferred0_0;
        let deferred0_1;
        try {
            deferred0_0 = arg0;
            deferred0_1 = arg1;
            console.error(getStringFromWasm0(arg0, arg1));
        } finally {
            wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
        }
    };
    imports.wbg.__wbg_getRandomValues_b8f5dbd5f3995a9e = function() { return handleError(function (arg0, arg1) {
        arg0.getRandomValues(arg1);
    }, arguments) };
    imports.wbg.__wbg_msCrypto_a61aeb35a24c1329 = function(arg0) {
        const ret = arg0.msCrypto;
        return ret;
    };
    imports.wbg.__wbg_new_405e22f390576ce2 = function() {
        const ret = new Object();
        return ret;
    };
    imports.wbg.__wbg_new_5e0be73521bc8c17 = function() {
        const ret = new Map();
        return ret;
    };
    imports.wbg.__wbg_new_8a6f238a6ece86ea = function() {
        const ret = new Error();
        return ret;
    };
    imports.wbg.__wbg_new_a12002a7f91c75be = function(arg0) {
        const ret = new Uint8Array(arg0);
        return ret;
    };
    imports.wbg.__wbg_newnoargs_105ed471475aaf50 = function(arg0, arg1) {
        const ret = new Function(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbg_newwithbyteoffsetandlength_d97e637ebe145a9a = function(arg0, arg1, arg2) {
        const ret = new Uint8Array(arg0, arg1 >>> 0, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_newwithlength_a381634e90c276d4 = function(arg0) {
        const ret = new Uint8Array(arg0 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_node_905d3e251edff8a2 = function(arg0) {
        const ret = arg0.node;
        return ret;
    };
    imports.wbg.__wbg_process_dc0fbacc7c1c06f7 = function(arg0) {
        const ret = arg0.process;
        return ret;
    };
    imports.wbg.__wbg_randomFillSync_ac0988aba3254290 = function() { return handleError(function (arg0, arg1) {
        arg0.randomFillSync(arg1);
    }, arguments) };
    imports.wbg.__wbg_require_60cc747a6bc5215a = function() { return handleError(function () {
        const ret = module.require;
        return ret;
    }, arguments) };
    imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
        arg0[arg1] = arg2;
    };
    imports.wbg.__wbg_set_65595bdd868b3009 = function(arg0, arg1, arg2) {
        arg0.set(arg1, arg2 >>> 0);
    };
    imports.wbg.__wbg_set_8fc6bf8a5b1071d1 = function(arg0, arg1, arg2) {
        const ret = arg0.set(arg1, arg2);
        return ret;
    };
    imports.wbg.__wbg_stack_0ed75d68575b0f3c = function(arg0, arg1) {
        const ret = arg1.stack;
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_88a902d13a557d07 = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0 = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_37c5d418e4bf5819 = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_5de37043a91a9c40 = function() {
        const ret = typeof window === 'undefined' ? null : window;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_subarray_aa9065fa9dc5df96 = function(arg0, arg1, arg2) {
        const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
        return ret;
    };
    imports.wbg.__wbg_versions_c01dfd4722a88165 = function(arg0) {
        const ret = arg0.versions;
        return ret;
    };
    imports.wbg.__wbindgen_debug_string = function(arg0, arg1) {
        const ret = debugString(arg1);
        const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
    };
    imports.wbg.__wbindgen_error_new = function(arg0, arg1) {
        const ret = new Error(getStringFromWasm0(arg0, arg1));
        return ret;
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_4;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };
    imports.wbg.__wbindgen_is_function = function(arg0) {
        const ret = typeof(arg0) === 'function';
        return ret;
    };
    imports.wbg.__wbindgen_is_object = function(arg0) {
        const val = arg0;
        const ret = typeof(val) === 'object' && val !== null;
        return ret;
    };
    imports.wbg.__wbindgen_is_string = function(arg0) {
        const ret = typeof(arg0) === 'string';
        return ret;
    };
    imports.wbg.__wbindgen_is_undefined = function(arg0) {
        const ret = arg0 === undefined;
        return ret;
    };
    imports.wbg.__wbindgen_memory = function() {
        const ret = wasm.memory;
        return ret;
    };
    imports.wbg.__wbindgen_number_new = function(arg0) {
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedDataViewMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        throw new Error();
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
