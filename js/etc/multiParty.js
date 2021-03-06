Cryptodog.multiParty = function() {};

(function(){
'use strict';

var usedIVs = []

var correctIvLength = function(iv){
	var ivAsWordArray = CryptoJS.enc.Base64.parse(iv)
	var ivAsArray = ivAsWordArray.words
	ivAsArray.push(0)  // adds 0 as the 4th element, causing the equivalent
					   // bytestring to have a length of 16 bytes, with
					   // \x00\x00\x00\x00 at the end.
					   // without this, crypto-js will take in a counter of
					   // 12 bytes, and the first 2 counter iterations will
					   // use 0, instead of 0 and then 1.
					   // see https://github.com/cryptocat/cryptocat/issues/258
	return CryptoJS.lib.WordArray.create(ivAsArray)
}

// AES-CTR-256 encryption
// No padding, starting IV of 0
// Input: WordArray, Output: Base64
// Key input: WordArray
var encryptAES = function(msg, c, iv) {
	var opts = {
		mode: CryptoJS.mode.CTR,
		iv: correctIvLength(iv),
		padding: CryptoJS.pad.NoPadding
	}
	var aesctr = CryptoJS.AES.encrypt(
		msg,
		c,
		opts
	)
	return aesctr.toString()
}

// AES-CTR-256 decryption
// No padding, starting IV of 0
// Input: Base64, Output: WordArray
// Key input: WordArray
var decryptAES = function(msg, c, iv) {
	var opts = {
		mode: CryptoJS.mode.CTR,
		iv: correctIvLength(iv),
		padding: CryptoJS.pad.NoPadding
	}
	var aesctr = CryptoJS.AES.decrypt(
		msg,
		c,
		opts
	)
	return aesctr
}

// HMAC-SHA512
// Output: Base64
// Key input: WordArray
var HMAC = function(msg, key) {
	return CryptoJS.HmacSHA512(
		msg, key
	).toString(CryptoJS.enc.Base64)
}

// Generate private key (32 random bytes)
// Represented as BigInt
Cryptodog.multiParty.genPrivateKey = function() {
	return BigInt.randBigInt(256)
}

// Generate public key (Curve 25519 Diffie-Hellman with basePoint 9)
// Represented as BigInt
Cryptodog.multiParty.genPublicKey = function(privateKey) {
	return Curve25519.ecDH(privateKey)
}

// Generate shared secrets
// First 256 bytes are for encryption, last 256 bytes are for HMAC.
// Represented as WordArrays
Cryptodog.multiParty.genSharedSecret = function(nickname) {
	//I need to convert the BigInt to WordArray here. I do it using the Base64 representation.
	var sharedSecret = CryptoJS.SHA512(
		CryptoJS.enc.Base64.parse(
			BigInt.bigInt2base64(
				Curve25519.ecDH(
					Cryptodog.me.mpPrivateKey,
					Cryptodog.buddies[nickname].mpPublicKey
				),
				32
			)
		)
	)
	return {
		'message': CryptoJS.lib.WordArray.create(sharedSecret.words.slice(0, 8)),
		'hmac': CryptoJS.lib.WordArray.create(sharedSecret.words.slice(8, 16))
	}
}

// Get fingerprint
// If nickname is null, returns own fingerprint
Cryptodog.multiParty.genFingerprint = function(nickname) {
	var key = Cryptodog.me.mpPublicKey
	if (nickname) {
		key = Cryptodog.buddies[nickname].mpPublicKey
	}
	return CryptoJS.SHA512(
		CryptoJS.enc.Base64.parse(
			BigInt.bigInt2base64(key, 32)
		)
	).toString().substring(0, 40).toUpperCase()
}

// Send my public key in response to a public key request.
Cryptodog.multiParty.sendPublicKey = function(nickname) {
	var answer = {}
	answer['type'] = 'publicKey'
	answer['text'] = {}
	answer['text'][nickname] = {}
	answer['text'][nickname]['message'] = BigInt.bigInt2base64(
		Cryptodog.me.mpPublicKey, 32
	)
	return JSON.stringify(answer)
}

// Issue a warning for decryption failure to the main conversation window
Cryptodog.multiParty.messageWarning = function(sender) {
	var messageWarning = Cryptodog.locale['warnings']['messageWarning']
		.replace('(NICKNAME)', sender)
	Cryptodog.addToConversation(messageWarning, sender, 'groupChat', 'warning')
}

// Generate message tag. 8 rounds of SHA512
// Input: WordArray
// Output: Base64
Cryptodog.multiParty.messageTag = function(message) {
	for (var i = 0; i !== 8; i++) {
		message = CryptoJS.SHA512(message)
	}
	return message.toString(CryptoJS.enc.Base64)
}

// Send message.
Cryptodog.multiParty.sendMessage = function(message) {
	//Convert from UTF8
	message = CryptoJS.enc.Utf8.parse(message)
	// Add 64 bytes of padding
	message.concat(Cryptodog.random.rawBytes(64))
	var encrypted = {
		text: {},
		type: 'message'
	}
	//Sort recipients
	var sortedRecipients = []
	for (var b in Cryptodog.buddies) {
		if (Cryptodog.buddies[b].mpSecretKey) {
			sortedRecipients.push(b)
		}
	}
	sortedRecipients.sort()
	var hmac = CryptoJS.lib.WordArray.create()
	//For each recipient
	var i, iv
	for (i = 0; i !== sortedRecipients.length; i++) {
		//Generate a random IV
		iv = Cryptodog.random.encodedBytes(12, CryptoJS.enc.Base64)
		// Do not reuse IVs
		while (usedIVs.indexOf(iv) >= 0) {
			iv = Cryptodog.random.encodedBytes(12, CryptoJS.enc.Base64)
		}
		usedIVs.push(iv)
		//Encrypt the message
		encrypted['text'][sortedRecipients[i]] = {}
		encrypted['text'][sortedRecipients[i]]['message'] = encryptAES(
			message,
			Cryptodog.buddies[sortedRecipients[i]].mpSecretKey['message'],
			iv
		)
		encrypted['text'][sortedRecipients[i]]['iv'] = iv
		//Append to HMAC
		hmac.concat(CryptoJS.enc.Base64.parse(encrypted['text'][sortedRecipients[i]]['message']))
		hmac.concat(CryptoJS.enc.Base64.parse(encrypted['text'][sortedRecipients[i]]['iv']))
	}
	encrypted['tag'] = message.clone()
	//For each recipient again
	for (i = 0; i !== sortedRecipients.length; i++) {
		//Compute the HMAC
		encrypted['text'][sortedRecipients[i]]['hmac'] = HMAC(
			hmac,
			Cryptodog.buddies[sortedRecipients[i]].mpSecretKey['hmac']
		)
		//Append to tag
		encrypted['tag'].concat(CryptoJS.enc.Base64.parse(encrypted['text'][sortedRecipients[i]]['hmac']))
	}
	//Compute tag
	encrypted['tag'] = Cryptodog.multiParty.messageTag(encrypted['tag'])
	return JSON.stringify(encrypted)
}

// Receive message. Detects requests/reception of public keys.
Cryptodog.multiParty.receiveMessage = function(sender, myName, message) {
	var buddy = Cryptodog.buddies[sender]
	try {
		message = JSON.parse(message)
	}
	catch(err) {
		console.log('multiParty: failed to parse message object')
		return false
	}
	if (typeof(message['text'][myName]) === 'object') {
		// Detect public key reception, store public key and generate shared secret
		if (message.type === 'publicKey') {
			var msg = message.text[myName].message
			if (typeof(msg) !== 'string') {
				console.log('multiParty: publicKey without message field')
				return false
			}
			var publicKey = BigInt.base642bigInt(msg)
			// if we already have a public key for this buddy, make sure it's
			// the one we have
			if (buddy.mpPublicKey &&
				!BigInt.equals(buddy.mpPublicKey, publicKey)
			) {
				buddy.updateMpKeys(publicKey)
				Cryptodog.UI.removeAuthAndWarn(sender)
			}
			// if we're missing their key, make sure we aren't already
			// authenticated (prevents a possible active attack)
			else if (!buddy.mpPublicKey && buddy.authenticated) {
				buddy.updateMpKeys(publicKey)
				Cryptodog.UI.removeAuthAndWarn(sender)
			} else {
				buddy.updateMpKeys(publicKey)
			}
			return false
		}
		// Detect public key request and send public key
		else if (message['type'] === 'publicKeyRequest') {
			Cryptodog.xmpp.sendPublicKey(sender)
		}
		else if (message['type'] === 'message') {
			// Make sure message is being sent to all chat room participants
			var recipients = Object.keys(Cryptodog.buddies)
			var missingRecipients = []
			recipients.splice(recipients.indexOf(sender), 1)
			for (var r = 0; r !== recipients.length; r++) {
				try {
					if (typeof(message['text'][recipients[r]]) === 'object') {
						var noMessage = typeof(message['text'][recipients[r]]['message']) !== 'string'
						var noIV = typeof(message['text'][recipients[r]]['iv']) !== 'string'
						var noHMAC = typeof(message['text'][recipients[r]]['hmac']) !== 'string'
						if (noMessage || noIV || noHMAC) {
							missingRecipients.push(recipients[r])
						}
					}
					else {
						missingRecipients.push(recipients[r])
					}
				}
				catch(err) {
					missingRecipients.push(recipients[r])
				}
			}
			if (missingRecipients.length) {
				Cryptodog.addToConversation(missingRecipients, sender, 'groupChat', 'missingRecipients')
			}
			// Decrypt message
			if (!Cryptodog.buddies[sender].mpSecretKey) {
				return false
			}
			// Sort recipients
			var sortedRecipients = Object.keys(message['text']).sort()
			// Check HMAC
			var hmac = CryptoJS.lib.WordArray.create()
			var i
			for (i = 0; i !== sortedRecipients.length; i++) {
				hmac.concat(CryptoJS.enc.Base64.parse(message['text'][sortedRecipients[i]]['message']))
				hmac.concat(CryptoJS.enc.Base64.parse(message['text'][sortedRecipients[i]]['iv']))
			}
			if (
				!OTR.HLP.compare(
					message['text'][myName]['hmac'],
					HMAC(hmac, Cryptodog.buddies[sender].mpSecretKey['hmac'])
				)
			) {
				console.log('multiParty: HMAC failure')
				Cryptodog.multiParty.messageWarning(sender)
				return false
			}
			// Check IV reuse
			if (usedIVs.indexOf(message['text'][myName]['iv']) >= 0) {
				console.log('multiParty: IV reuse detected, possible replay attack')
				Cryptodog.multiParty.messageWarning(sender)
				return false
			}
			usedIVs.push(message['text'][myName]['iv'])
			// Decrypt
			var plaintext = decryptAES(
				message['text'][myName]['message'],
				Cryptodog.buddies[sender].mpSecretKey['message'],
				message['text'][myName]['iv']
			)
			// Check tag
			var messageTag = plaintext.clone()
			for (i = 0; i !== sortedRecipients.length; i++) {
				messageTag.concat(CryptoJS.enc.Base64.parse(message['text'][sortedRecipients[i]]['hmac']))
			}
			if (Cryptodog.multiParty.messageTag(messageTag) !== message['tag']) {
				console.log('multiParty: message tag failure')
				Cryptodog.multiParty.messageWarning(sender)
				return false
			}
			// Remove padding
			if (plaintext.sigBytes < 64) {
				console.log('multiParty: invalid plaintext size')
				Cryptodog.multiParty.messageWarning(sender)
				return false
			}
			plaintext = CryptoJS.lib.WordArray.create(plaintext.words, plaintext.sigBytes-64)
			// Convert to UTF8
			return plaintext.toString(CryptoJS.enc.Utf8)
		}
		else {
			console.log('multiParty: Unknown message type: ' + message['type'])
			Cryptodog.multiParty.messageWarning(sender)
		}
	}
	return false
}

// Reset everything except my own key pair
Cryptodog.multiParty.reset = function() {
	usedIVs = []
}

})()//:3
