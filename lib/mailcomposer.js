var Stream = require("stream").Stream,
    utillib = require("util"),
    mimelib = require("mimelib-noiconv"),
    toPunycode = require("./punycode"),
    fs = require("fs");

module.exports.MailComposer = MailComposer;

/**
 * <p>Costructs a MailComposer object. This is a Stream instance so you could
 * pipe the output to a file or send it to network.</p>
 * 
 * <p>Possible options properties are:</p>
 * 
 * <ul>
 *     <li><b>escapeSMTP</b> - convert dots in the beginning of line to double dots</li>
 *     <li><b>encoding</b> - forced transport encoding (quoted-printable, base64, 7bit or 8bit)</li>
 * </ul>
 * 
 * <p><b>Events</b></p>
 * 
 * <ul>
 *     <li><b>'envelope'</b> - emits an envelope object with <code>from</code> and <code>to</code> (array) addresses.</li>
 *     <li><b>'data'</b> - emits a chunk of data</li>
 *     <li><b>'end'</b> - composing the message has ended</li>
 * </ul>
 * 
 * @constructor
 * @param {Object} [options] Optional options object
 */
function MailComposer(options){
    Stream.call(this);
    
    this.options = options || {};
    
    this._init();
}
utillib.inherits(MailComposer, Stream);

/**
 * <p>Resets and initializes MailComposer</p>
 */
MailComposer.prototype._init = function(){
    /**
     * <p>Contains all header values</p>
     * @private
     */
    this._headers = {};
    
    /**
     * <p>Contains message related values</p>
     * @private
     */
    this._message = {};
    
    /**
     * <p>Contains a list of attachments</p>
     * @private
     */
    this._attachments = [];
    
    /**
     * <p>Contains e-mail addresses for the SMTP</p>
     * @private
     */
    this._envelope = {};
    
    /**
     * <p>Counter for generating unique mime boundaries etc.</p>
     * @private
     */
    this._gencounter = 0;
    
    this.addHeader("MIME-Version", "1.0");
};

/* PUBLIC API */

/**
 * <p>Adds a header field to the headers object</p>
 * 
 * @param {String} key Key name
 * @param {String} value Header value
 */
MailComposer.prototype.addHeader = function(key, value){
    key = this._normalizeKey(key);
    value = (value || "").toString().trim();
    if(!key || !value){
        return;
    }
    
    if(!(key in this._headers)){
        this._headers[key] = value;
    }else{
        if(!Array.isArray(this._headers[key])){
            this._headers[key] = [this._headers[key], value];
        }else{
            this._headers[key].push(value);
        }
    }
};

/**
 * <p>Resets and initializes MailComposer</p>
 * 
 * <p>Setting an option overwrites an earlier setup for the same keys</p>
 * 
 * <p>Possible options:</p>
 * 
 * <ul>
 *     <li><b>from</b> - The e-mail address of the sender. All e-mail addresses can be plain <code>sender@server.com</code> or formatted <code>Sender Name &lt;sender@server.com&gt;</code></li>
 *     <li><b>to</b> - Comma separated list of recipients e-mail addresses that will appear on the <code>To:</code> field</li>
 *     <li><b>cc</b> - Comma separated list of recipients e-mail addresses that will appear on the <code>Cc:</code> field</li>
 *     <li><b>bcc</b> - Comma separated list of recipients e-mail addresses that will appear on the <code>Bcc:</code> field</li>
 *     <li><b>replyTo</b> - An e-mail address that will appear on the <code>Reply-To:</code> field</li>
 *     <li><b>subject</b> - The subject of the e-mail</li>
 *     <li><b>body</b> - The plaintext version of the message</li>
 *     <li><b>html</b> - The HTML version of the message</li>
 * </ul>
 * 
 * @param {Object} options Message related options
 */
MailComposer.prototype.setMessageOption = function(options){
    var fields = ["from", "to", "cc", "bcc", "replyTo", "subject", "body", "html"],
        rewrite = {"sender":"from", "reply_to":"replyTo"};
    
    options = options || {};
    
    var keys = Object.keys(options), key, value;
    for(var i=0, len=keys.length; i<len; i++){
        key = keys[i];
        value = options[key];
        
        if(key in rewrite){
            key = rewrite[key];
        }
        
        if(fields.indexOf(key) >= 0){
            this._message[key] = this._handleValue(key, value);
        }
    }
};

/**
 * <p>Adds an attachment to the list</p>
 * 
 * <p>Following options are allowed:</p>
 * 
 * <ul>
 *     <li><b>fileName</b> - filename for the attachment</li>
 *     <li><b>contentType</b> - content type for the attachmetn (default will be derived from the filename)</li>
 *     <li><b>cid</b> - Content ID value for inline images</li>
 *     <li><b>contents</b> - String or Buffer attachment contents</li>
 *     <li><b>filePath</b> - Path to a file for streaming</li>
 * </ul>
 * 
 * <p>One of <code>contents</code> or <code>filePath</code> must be specified, otherwise
 * the attachment is not included</p>
 * 
 * @param {Object} attachment Attachment info
 */
MailComposer.prototype.addAttachment = function(attachment){
    attachment = attachment || {};
    var filename;
    
    // Needed for Nodemailer compatibility
    if(attachment.filename){
        attachment.fileName = attachment.filename;
        delete attachment.filename;
    }
    
    if(!attachment.contentType){
        filename = attachment.fileName || attachment.filePath;
        if(filename){
            attachment.contentType = this._getMimeType(filename);
        }else{
            attachment.contentType = "application/octet-stream";
        }
    }
    
    if(attachment.filePath || attachment.contents){
        this._attachments.push(attachment);
    }
};

/**
 * <p>Starts streaming the message</p>
 */
MailComposer.prototype.streamMessage = function(){
    process.nextTick(this._composeMessage.bind(this));
};

/* PRIVATE API */

/**
 * <p>Handles a message object value, converts addresses etc.</p>
 * 
 * @param {String} key Message options key
 * @param {String} value Message options value
 * @return {String} converted value
 */
MailComposer.prototype._handleValue = function(key, value){
    key = (key || "").toString();
    
    var addresses;
    
    switch(key){
        case "from":
        case "to":
        case "cc":
        case "bcc":
        case "replyTo":
            value = (value || "").toString().replace(/\r?\n|\r/g, " ");
            addresses = mimelib.parseAddresses(value);
            this._envelope[key] = addresses.map((function(address){
                if(this._hasUTFChars(address.address)){
                    return toPunycode(address.address);
                }else{
                    return address.address;
                }
            }).bind(this));
            return this._convertAddresses(addresses);
        case "subject":
            value = (value || "").toString().replace(/\r?\n|\r/g, " ");
            return this._encodeMimeWord(value, "Q", 78);
    }
    
    return value;
};

/**
 * <p>Handles a list of parsed e-mail addresses, checks encoding etc.</p>
 * 
 * @param {Array} value A list or single e-mail address <code>{address:'...', name:'...'}</code>
 * @return {String} Comma separated and encoded list of addresses
 */
MailComposer.prototype._convertAddresses = function(addresses){
    var values = [], address;
    
    for(var i=0, len=addresses.length; i<len; i++){
        address = addresses[i];
        
        if(address.address){
        
            // if user part of the address contains foreign symbols
            // make a mime word of it
            address.address = address.address.replace(/^.*?(?=\@)/, (function(user){
                if(this._hasUTFChars(user)){
                    return mimelib.encodeMimeWord(user, "Q");
                }else{
                    return user;
                }
            }).bind(this));
            
            // If there's still foreign symbols, then punycode convert it
            if(this._hasUTFChars(address.address)){
                address.address = toPunycode(address.address);
            }
        
            if(!address.name){
                values.push(address.address);
            }else if(address.name){
                if(this._hasUTFChars(address.name)){
                    address.name = this._encodeMimeWord(address.name, "Q", 78);
                }else{
                    address.name = address.name;
                }
                values.push('"' + address.name+'" <'+address.address+'>');
            }
        }
    }
    return values.join(", ");
};



/**
 * <p>Gets a header field</p>
 * 
 * @param {String} key Key name
 * @return {String|Array} Header field - if several values, then it's an array
 */
MailComposer.prototype._getHeader = function(key){
    var value;
    
    key = this._normalizeKey(key);
    value = this._headers[key] || "";
    
    return value;
};




/**
 * <p>Generate an e-mail from the described info</p>
 */
MailComposer.prototype._composeMessage = function(){
    
    //Emit addresses for the SMTP client
    this._composeEnvelope();
    
    // Generate headers for the message
    this._composeHeader();
    
    // Make the mime tree flat
    this._flattenMimeTree();
    
    // Compose message body
    this._composeBody();
    
};

/**
 * <p>Composes and emits an envelope from the <code>this._envelope</code> 
 * object. Needed for the SMTP client</p>
 * 
 * <p>Emitted envelope is int hte following structure:</p>
 * 
 * <pre>
 * {
 *     to: "address",
 *     from: ["list", "of", "addresses"]
 * }
 * </pre>
 * 
 * <p>Both properties (<code>from</code> and <code>to</code>) are optional
 * and may not exist</p>
 */
MailComposer.prototype._composeEnvelope = function(){
    var envelope = {},
        toKeys = ["to", "cc", "bcc"],
        key;
    
    // If multiple addresses, only use the first one
    if(this._envelope.from && this._envelope.from.length){
        envelope.from = [].concat(this._envelope.from).shift();
    }
    
    for(var i=0, len=toKeys.length; i<len; i++){
        key = toKeys[i];
        if(this._envelope[key] && this._envelope[key].length){
            if(!envelope.to){
                envelope.to = [];
            }
            envelope.to = envelope.to.concat(this._envelope[key]);
        }
    }
    
    this.emit("envelope", envelope);
};

/**
 * <p>Composes a header for the message and emits it with a <code>'data'</code>
 * event</p>
 * 
 * <p>Also checks and build a structure for the message (is it a multipart message
 * and does it need a boundary etc.)</p>
 * 
 * <p>By default the message is not a multipart. If the message containes both
 * plaintext and html contents, an alternative block is used. it it containes
 * attachments, a mixed block is used. If both alternative and mixed exist, then
 * alternative resides inside mixed.</p>
 */
MailComposer.prototype._composeHeader = function(){
    var headers = [];

    if(this._attachments.length){
        this._message.useMixed = true;
        this._message.mixedBoundary = this._generateBoundary();
    }else{
        this._message.useMixed = false;
    }
    
    if(this._message.body && this._message.html){
        this._message.useAlternative = true;
        this._message.alternativeBoundary = this._generateBoundary();
    }else{
        this._message.useAlternative = false;
    }
    
    if(!this._message.html && !this._message.body){
        // If there's nothing to show, show a linebreak
        this._message.body = "\r\n";
    }
    
    this._buildMessageHeaders();
    this._generateBodyStructure();
    
    // Compile header lines
    headers = this.compileHeaders(this._headers);
    
    this.emit("data", new Buffer(headers.join("\r\n")+"\r\n\r\n", "utf-8"));
};

/**
 * <p>Uses data from the <code>this._message</code> object to build headers</p>
 */
MailComposer.prototype._buildMessageHeaders = function(){
    var contentType;

    // FROM
    if(this._message.from && this._message.from.length){
        [].concat(this._message.from).forEach((function(from){
            this.addHeader("From", from);
        }).bind(this));
    }
    
    // TO
    if(this._message.to && this._message.to.length){
        [].concat(this._message.to).forEach((function(to){
            this.addHeader("To", to);
        }).bind(this));
    }
    
    // CC
    if(this._message.cc && this._message.cc.length){
        [].concat(this._message.cc).forEach((function(cc){
            this.addHeader("Cc", cc);
        }).bind(this));
    }
    
    // REPLY-TO
    if(this._message.replyTo && this._message.replyTo.length){
        [].concat(this._message.replyTo).forEach((function(replyTo){
            this.addHeader("Reply-To", replyTo);
        }).bind(this));
    }
    
    // SUBJECT
    if(this._message.subject){
        this.addHeader("Subject", this._message.subject);
    }
};

/**
 * <p>Generates the structure (mime tree) of the body. This sets up multipart
 * structure, individual part headers, boundaries etc.</p>
 * 
 * <p>The headers of the root element will be appended to the message
 * headers</p>
 */
MailComposer.prototype._generateBodyStructure = function(){
    // TODO: lõpetada
    var tree = this._createMimeNode(), 
        currentNode, node,
        i, len;
    
    if(this._message.useMixed){
        
        node = this._createMimeNode();
        node.boundary = this._message.mixedBoundary;
        node.headers.push(["Content-Type", "multipart/mixed; boundary=\""+node.boundary+"\""]);
        
        if(currentNode){
            currentNode.childNodes.push(node);
            node.parentNode = currentNode;
        }else{
            tree = node;
        }
        currentNode = node;
    
    }
    
    if(this._message.useAlternative){
    
        node = this._createMimeNode();
        node.boundary = this._message.alternativeBoundary;
        node.headers.push(["Content-Type", "multipart/alternative; boundary=\""+node.boundary+"\""]);
        if(currentNode){
            currentNode.childNodes.push(node);
            node.parentNode = currentNode;
        }else{
            tree = node;
        }
        currentNode = node;
        
    }
    
    if(this._message.body){
        node = this._createTextComponent(this._message.body, "text/plain");
        if(currentNode){
            currentNode.childNodes.push(node);
            node.parentNode = currentNode;
        }else{
            tree = node;
        }
    }
    
    if(this._message.html){
        node = this._createTextComponent(this._message.html, "text/html");
        if(currentNode){
            currentNode.childNodes.push(node);
            node.parentNode = currentNode;
        }else{
            tree = node;
        }
    }
    
    // Attachments are added to the first element (should be multipart/mixed)
    currentNode = tree;
    if(this._attachments){
        for(i=0, len = this._attachments.length; i<len; i++){
            node = this._createAttachmentComponent(this._attachments[i]);
            node.parentNode = currentNode;
            currentNode.childNodes.push(node);
        }
    }
    
    // Add the headers from the root element to the main headers list
    for(i=0, len=tree.headers.length; i<len; i++){
        this.addHeader(tree.headers[i][0], tree.headers[i][1]);
    }
    
    this._message.tree = tree;
};

/**
 * <p>Creates a mime tree node for a text component (plaintext, HTML)</p>
 * 
 * @param {String} text Text contents for the component
 * @param {String} [contentType="text/plain"] Content type for the text component
 * @return {Object} Mime tree node 
 */
MailComposer.prototype._createTextComponent = function(text, contentType){
    var node = this._createMimeNode();
    
    node.contentEncoding = (this.options.encoding || "quoted-printable").toLowerCase().trim();
    node.useTextType = true;
    
    contentType = [contentType || "text/plain"];
    contentType.push("charset=utf-8");
    
    if(["7bit", "8bit", "binary"].indexOf(node.contentEncoding)>=0){
        node.textFormat = "flowed";
        contentType.push("format=" + node.textFormat);
    }
    
    node.headers.push(["Content-Type", contentType.join("; ")]);
    node.headers.push(["Content-Transfer-Encoding", node.contentEncoding]);
    
    node.contents = text;
    
    return node;
};

/**
 * <p>Creates a mime tree node for a text component (plaintext, HTML)</p>
 * 
 * @param {Object} attachment Attachment info for the component
 * @return {Object} Mime tree node 
 */
MailComposer.prototype._createAttachmentComponent = function(attachment){
    var node = this._createMimeNode(),
        contentType = [attachment.contentType],
        contentDisposition = ["attachment"],
        fileName;
    
    node.contentEncoding = "base64";
    node.useAttachmentType = true;
    
    if(attachment.fileName){
        fileName = this._encodeMimeWord(attachment.fileName, "Q", 1024).replace(/"/g,"\\\"");
        contentType.push("name=\"" +fileName+ "\"");
        contentDisposition.push("filename=\"" +fileName+ "\"");
    }
    
    node.headers.push(["Content-Type", contentType.join("; ")]);
    node.headers.push(["Content-Disposition", contentDisposition.join("; ")]);
    node.headers.push(["Content-Transfer-Encoding", node.contentEncoding]);
    
    if(attachment.cid){
        node.headers.push(["Content-Id", "<" + this._encodeMimeWord(attachment.cid) + ">"]);
    }
    
    if(attachment.contents){
        node.contents = attachment.contents;
    }else if(attachment.filePath){
        node.filePath = attachment.filePath;
    }

    return node;
};

/**
 * <p>Creates an empty mime tree node</p>
 * 
 * @return {Object} Mime tree node
 */
MailComposer.prototype._createMimeNode = function(){
    return {
        childNodes: [],
        headers: [],
        parentNode: null
    };
};

/**
 * <p>Compiles headers object into an array of header lines. If needed, the
 * lines are folded</p>
 * 
 * @param {Object|Array} headers An object with headers in the form of
 *        <code>{key:value}</code> or <ocde>[[key, value]]</code> or
 *        <code>[{key:key, value: value}]</code>
 * @return {Array} A list of header lines. Can be joined with \r\n
 */
MailComposer.prototype.compileHeaders = function(headers){
    var headersArr = [], keys, key;
    
    if(Array.isArray(headers)){
        headersArr = headers.map(function(field){
            return mimelib.foldLine((field.key || field[0])+": "+(field.value || field[1]));
        });
    }else{
        keys = Object.keys(headers);
        for(var i=0, len = keys.length; i<len; i++){
            key = this._normalizeKey(keys[i]);
            
            headersArr = headersArr.concat([].concat(headers[key]).map(function(field){
                return mimelib.foldLine(key+": "+field);
            }));
        }
    }
    
    return headersArr;
};

/**
 * <p>Converts a structured mimetree into an one dimensional array of
 * components. This includes headers and multipart boundaries as strings,
 * textual and attachment contents are.</p>
 */
MailComposer.prototype._flattenMimeTree = function(){
    var flatTree = [];
    
    function walkTree(node, level){
        var contentObject = {};
        level = level || 0;
        
        // if not root element, include headers
        if(level){
            flatTree = flatTree.concat(this.compileHeaders(node.headers));
            flatTree.push('');
        }
        
        if(node.textFormat){
            contentObject.textFormat = node.textFormat;
        }
        
        if(node.contentEncoding){
            contentObject.contentEncoding = node.contentEncoding;
        }
        
        if(node.contents){
            contentObject.contents = node.contents;
        }
        
        if(node.filePath){
            contentObject.filePath = node.filePath;
        }
        
        if(node.contents || node.filePath){
            flatTree.push(contentObject);
        }
        
        // walk children
        for(var i=0, len = node.childNodes.length; i<len; i++){
            if(node.boundary){
                flatTree.push("--"+node.boundary);
            }
            walkTree.call(this, node.childNodes[i], level+1);
        }
        if(node.boundary && node.childNodes.length){
            flatTree.push("--"+node.boundary+"--");
            flatTree.push('');
        }
    }
    
    walkTree.call(this, this._message.tree);
    
    if(flatTree.length && flatTree[flatTree.length-1]===''){
        flatTree.pop();
    }
    
    this._message.flatTree = flatTree;
};

/**
 * <p>Composes the e-mail body based on the previously generated mime tree</p>
 * 
 * <p>Assumes that the linebreak separating headers and contents is already 
 * sent</p>
 * 
 * <p>Emits 'data' events</p>
 */
MailComposer.prototype._composeBody = function(){
    var flatTree = this._message.flatTree,
        slice, isObject = false, isEnd = false,
        curObject;
    
    this._message.processingStart = this._message.processingStart || 0;
    this._message.processingPos = this._message.processingPos || 0;

    for(len = flatTree.length; this._message.processingPos < len; this._message.processingPos++){
        
        isEnd = this._message.processingPos >= len-1;
        isObject = typeof flatTree[this._message.processingPos] == "object";
        
        if(isEnd || isObject){
            
            slice = flatTree.slice(this._message.processingStart, isEnd && !isObject?undefined:this._message.processingPos);
            if(slice && slice.length){
                this.emit("data", new Buffer(slice.join("\r\n")+"\r\n", "utf-8"));
            }
            
            if(isObject){
                curObject = flatTree[this._message.processingPos];
            
                this._message.processingPos++;
                this._message.processingStart = this._message.processingPos;
            
                this._emitDataElement(curObject, (function(){
                    if(!isEnd){
                        process.nextTick(this._composeBody.bind(this));
                    }else{
                        this.emit("end");
                    }
                }).bind(this));
                
            }else if(isEnd){
                this.emit("end");
            }
            break;
        }
        
    }
};

/**
 * <p>Emits a data event for a text or html body and attachments. If it is a 
 * file, stream it</p>
 * 
 * <p>If <code>this.options.escapeSMTP</code> is true, replace dots in the
 * beginning of a line with double dots - only valid for QP encoding</p>
 * 
 * @param {Object} element Data element descriptor
 * @param {Function} callback Callback function to run when completed
 */
MailComposer.prototype._emitDataElement = function(element, callback){
    
    var data;
    
    if(element.contents){
        switch(element.contentEncoding){
            case "quoted-printable":
                data = mimelib.encodeQuotedPrintable(element.contents);
                break;
            case "base64":
                data = new Buffer(element.contents, "utf-8").toString("base64").replace(/.{76}/g,"$&\r\n");
                break;
            case "7bit":
            case "8bit":
            case "binary":
            default:
                data = mimelib.foldLine(element.contents, 78, false, element.textFormat=="flowed");
                 //mimelib puts a long whitespace to the beginning of the lines
                data = data.replace(/^[ ]{7}/mg, "");
                break;
        }
        
        if(this.options.escapeSMTP){
            data = data.replace(/^\./gm,'..');
        }
        
        this.emit("data", new Buffer(data + "\r\n", "utf-8"));
        process.nextTick(callback);
        return;
    }

    if(element.filePath){
        this._serveFile(element.filePath, callback);
        return;
    }

    callback();
};

/**
 * <p>Pipes a file to the e-mail stream</p>
 * 
 * <p>This function opens a file and starts sending 76 bytes long base64
 * encoded lines. To achieve this, the incoming stream is divded into
 * chunks of 57 bytes (57/3*4=76) to achieve exactly 76 byte long
 * base64</p>
 * 
 * @param {String} filePath Path to the file
 * @param {Function} callback Callback function to run after completion
 */
MailComposer.prototype._serveFile = function(filePath, callback){
    var stream, remainder = new Buffer(0);
    fs.stat(filePath, (function(err, stat){
        if(err || !stat.isFile()){
            this.emit("data", new Buffer(new Buffer("<ERROR OPENING FILE>", 
                                "utf-8").toString("base64")+"\r\n", "utf-8"));
            process.nextTick(callback);
            return;
        }
        
        stream = fs.createReadStream(filePath);
        
        stream.on("error", (function(error){
            this.emit("data", new Buffer(new Buffer("<ERROR READING FILE>", 
                                "utf-8").toString("base64")+"\r\n", "utf-8"));
            process.nextTick(callback);
        }).bind(this));
        
        stream.on("data", (function(chunk){
            var data = "",
                len = remainder.length + chunk.length,
                remainderLength = len % 57, // we use 57 bytes as it composes
                                            // a 76 bytes long base64 string
                buffer = new Buffer(len);
            
            remainder.copy(buffer); // copy remainder into the beginning of the new buffer
            chunk.copy(buffer, remainder.length); // copy data chunk after the remainder
            remainder = buffer.slice(len - remainderLength); // create a new remainder
            
            data = buffer.slice(0, len - remainderLength).toString("base64").replace(/.{76}/g,"$&\r\n");
            
            if(data.length){
                this.emit("data", new Buffer(data.trim()+"\r\n", "utf-8"));
            }
        }).bind(this));
        
        stream.on("end", (function(chunk){
            var data;
            
            // stream the remainder (if any)
            if(remainder.length){
                data = remainder.toString("base64").replace(/.{76}/g,"$&\r\n");
                this.emit("data", new Buffer(data.trim()+"\r\n", "utf-8"));
            }
            process.nextTick(callback);
        }).bind(this));
        
    }).bind(this));
};

/* HELPER FUNCTIONS */

/**
 * <p>Normalizes a key name by cpitalizing first chars of words</p>
 * 
 * <p><code>x-mailer</code> will become <code>X-Mailer</code></p>
 * 
 * <p>Needed to avoid duplicate header keys</p>
 * 
 * @param {String} key Key name
 * @return {String} First chars uppercased
 */
MailComposer.prototype._normalizeKey = function(key){
    return (key || "").toString().trim().
        toLowerCase().
        replace(/^\S|[\-\s]\S/g, function(c){
            return c.toUpperCase();
        }).replace(/^MIME\-/i, "MIME-");
};

/**
 * <p>Tests if a string has high bit (UTF-8) symbols</p>
 * 
 * @param {String} str String to be tested for high bit symbols
 * @return {Boolean} true if high bit symbols were found
 */
MailComposer.prototype._hasUTFChars = function(str){
    var rforeign = /[^\u0000-\u007f]/;
    return !!rforeign.test(str);
};

/**
 * <p>Generates a boundary for multipart bodies</p>
 * 
 * @return {String} Boundary String
 */
MailComposer.prototype._generateBoundary = function(){
    // "_" is not allowed in quoted-printable and "?" not in base64
    return "----mailcomposer-?=_"+(++this._gencounter)+"-"+Date.now();
};

/**
 * <p>Converts a string to mime word format. If the length is longer than
 * <code>maxlen</code>, split it</p>
 * 
 * <p>If the string doesn't have any unicode characters return the original 
 * string instead</p>
 * 
 * @param {String} str String to be encoded
 * @param {String} encoding Either Q for Quoted-Printable or B for Base64
 * @param {Number} [maxlen] Optional length of the resulting string, whitespace will be inserted if needed
 * 
 * @return {String} Mime-word encoded string (if needed)
 */
MailComposer.prototype._encodeMimeWord = function(str, encoding, maxlen){
    encoding = (encoding || "Q").toUpperCase(); 
    if(this._hasUTFChars(str)){
        str = mimelib.encodeMimeWord(str, encoding);
        if(maxlen && str.length>maxlen){
            return str.replace(new RegExp(".{"+maxlen+"}","g"),"$&?= =?UTF-8?"+encoding+"?");
        }else{
            return str;
        }
    }else{
        return str;
    }
};

/**
 * <p>Resolves a mime type for a filename</p>
 * 
 * @param {String} filename Filename to check
 * @return {String} Corresponding mime type
 */
MailComposer.prototype._getMimeType = function(filename){
    var defaultMime = "application/octet-stream",
        extension = filename && filename.substr(filename.lastIndexOf(".")+1).trim().toLowerCase();
    return extension && mimelib.contentTypes[extension] || defaultMime;
};