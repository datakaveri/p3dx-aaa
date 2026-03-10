package contract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

func canonicalBytes(c Contract) ([]byte, error) {
	tmp := c
	tmp.Signatures = Signatures{} // exclude signatures before hashing
	return json.Marshal(tmp)
}

func ComputeHash(c Contract) (string, []byte, error) {

	b, err := canonicalBytes(c)
	if err != nil {
		return "", nil, err
	}

	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:]), sum[:], nil
}
