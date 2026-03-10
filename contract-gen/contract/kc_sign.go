package contract

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"time"
)

type KCClaims struct {
	UserID    string
	SessionID string
	Expiry    int64
	IssuedAt  int64
}

func SignWithKeycloakSession(
	c *Contract,
	claims KCClaims,
	serverSecret []byte,
) error {

	hashString, hashBytes, err := ComputeHash(*c)
	if err != nil {
		return err
	}

	msg := fmt.Sprintf(
		"%x|%s|%s|%d",
		hashBytes,
		claims.UserID,
		claims.SessionID,
		claims.IssuedAt,
	)

	h := hmac.New(sha256.New, serverSecret)
	h.Write([]byte(msg))
	signature := h.Sum(nil)

	now := time.Now().UTC()

	c.Signatures.ContractHash = hashString
	c.Signatures.SignatureAlgorithm = "KEYCLOAK_SESSION_HMAC_SHA256"
	c.Signatures.ConsumerSignature = base64.StdEncoding.EncodeToString(signature)
	c.Signatures.SignedAt.Consumer = &now

	return nil
}
