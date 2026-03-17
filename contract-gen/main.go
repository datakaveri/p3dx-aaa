package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"contract-test/contract"

	"github.com/google/uuid"
)

type jwtPayload struct {
	Sub string `json:"sub"`
	Sid string `json:"sid"`
	Iat int64  `json:"iat"`
	Exp int64  `json:"exp"`
}

type input struct {
	JWT           string     `json:"jwt"`
	DatasetID     string     `json:"datasetId"`
	ApplicationID string     `json:"applicationId"`
	Overrides     *overrides `json:"overrides,omitempty"`
}

type overrides struct {
	ContractID               *string                            `json:"contract_id,omitempty"`
	Version                  *int                               `json:"version,omitempty"`
	Description              *string                            `json:"description,omitempty"`
	Lifecycle                *contract.Lifecycle                `json:"lifecycle,omitempty"`
	ExecutionType            *string                            `json:"execution_type,omitempty"`
	ExecutionPlatform        *string                            `json:"execution_platform,omitempty"`
	Parties                  *contract.Parties                  `json:"parties,omitempty"`
	DataProviderTerms        *contract.DataProviderTerms        `json:"data_provider_terms,omitempty"`
	ApplicationProviderTerms *contract.ApplicationProviderTerms `json:"application_provider_terms,omitempty"`
	ConsumerTerms            *contract.ConsumerTerms            `json:"consumer_terms,omitempty"`
}

func extractClaims(jwt string) (contract.KCClaims, error) {
	parts := strings.Split(jwt, ".")
	if len(parts) < 2 {
		return contract.KCClaims{}, fmt.Errorf("invalid JWT")
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return contract.KCClaims{}, err
	}

	var p jwtPayload
	if err := json.Unmarshal(payloadBytes, &p); err != nil {
		return contract.KCClaims{}, err
	}

	if p.Sub == "" {
		return contract.KCClaims{}, fmt.Errorf("missing sub claim")
	}

	// sid is not always present in all Keycloak configs; allow empty.
	return contract.KCClaims{
		UserID:    p.Sub,
		SessionID: p.Sid,
		IssuedAt:  p.Iat,
		Expiry:    p.Exp,
	}, nil
}

func readInput(r io.Reader) (input, error) {
	br := bufio.NewReader(r)
	data, err := io.ReadAll(br)
	if err != nil {
		return input{}, err
	}

	var in input
	if err := json.Unmarshal(data, &in); err != nil {
		return input{}, fmt.Errorf("invalid JSON input: %w", err)
	}
	if strings.TrimSpace(in.JWT) == "" {
		return input{}, errors.New("jwt is required")
	}
	if strings.TrimSpace(in.DatasetID) == "" {
		return input{}, errors.New("datasetId is required")
	}
	if strings.TrimSpace(in.ApplicationID) == "" {
		return input{}, errors.New("applicationId is required")
	}
	return in, nil
}

func main() {
	in, err := readInput(os.Stdin)
	if err != nil {
		panic(err)
	}

	claims, err := extractClaims(in.JWT)
	if err != nil {
		panic(err)
	}

	secretRaw := os.Getenv("CONTRACT_SERVER_SECRET")
	if strings.TrimSpace(secretRaw) == "" {
		panic("CONTRACT_SERVER_SECRET is required")
	}
	secret := []byte(secretRaw)

	created := time.Now().UTC()
	expires := created.Add(90 * 24 * time.Hour)

	c := contract.Contract{
		ContractID:  uuid.NewString(),
		Version:     1,
		Description: fmt.Sprintf("workload dataset=%s application=%s", in.DatasetID, in.ApplicationID),

		Lifecycle: contract.Lifecycle{
			CreatedAt:  created,
			ValidFrom:  created,
			ValidUntil: expires,
		},

		ExecutionType:     "TRAINING",
		ExecutionPlatform: "AZURE_AMD_SEV",

		Parties: contract.Parties{
			DataProvider: contract.Party{
				ID:             "dp-uuid-placeholder",
				Name:           "Data Provider",
				OrganizationID: "dp-org-placeholder",
				PublicKey:      "ed25519:DP_PUBLIC_KEY_BASE64",
			},
			ApplicationProvider: contract.Party{
				ID:             "ap-uuid-placeholder",
				Name:           "Application Provider",
				OrganizationID: "ap-org-placeholder",
				PublicKey:      "ed25519:AP_PUBLIC_KEY_BASE64",
			},
			Consumer: contract.Party{
				ID:        claims.UserID,
				Name:      "Keycloak User",
				PublicKey: "ed25519:USER_PUBLIC_KEY_BASE64",
			},
		},

		DataProviderTerms: contract.DataProviderTerms{
			DataResourceID: in.DatasetID,
			DatasetName:    in.DatasetID,
			DatasetVersion: "v1",
			DataURL:        "https://example.invalid/data",
			DataHash:       "sha256:placeholder",
			Format:         "UNKNOWN",
			DataSizeBytes:  0,
			LicenseType:    "UNKNOWN",
			Constraints: contract.Constraints{
				AccessibilityLevel: "PUBLIC",
			},
		},

		ApplicationProviderTerms: contract.ApplicationProviderTerms{
			AppID:           in.ApplicationID,
			AppName:         in.ApplicationID,
			AppVersion:      "v1",
			AppHash:         "sha256:placeholder",
			ContainerImage:  "registry.example.com/app:latest",
			ContainerDigest: "sha256:placeholder",
			Constraints: contract.Constraints{
				AccessibilityLevel: "PUBLIC",
			},
			Usage: contract.UsageConstraints{
				MaxRequests:  10000,
				MaxBatchSize: 256,
			},
		},

		ConsumerTerms: contract.ConsumerTerms{
			SelectedAppID:      in.ApplicationID,
			SelectedAppVersion: "v1",
			DataBlobURL:        "https://example.invalid/blob",
			UsageConstraints: contract.UsageConstraints{
				MaxRequests:  10000,
				MaxBatchSize: 256,
				ResultFormat: "JSON",
			},
			DataRetention: "DELETE_AFTER_EXECUTION",
		},
	}

	if in.Overrides != nil {
		if in.Overrides.ContractID != nil && strings.TrimSpace(*in.Overrides.ContractID) != "" {
			c.ContractID = strings.TrimSpace(*in.Overrides.ContractID)
		}
		if in.Overrides.Version != nil {
			c.Version = *in.Overrides.Version
		}
		if in.Overrides.Description != nil {
			c.Description = *in.Overrides.Description
		}
		if in.Overrides.Lifecycle != nil {
			c.Lifecycle = *in.Overrides.Lifecycle
		}
		if in.Overrides.ExecutionType != nil {
			c.ExecutionType = *in.Overrides.ExecutionType
		}
		if in.Overrides.ExecutionPlatform != nil {
			c.ExecutionPlatform = *in.Overrides.ExecutionPlatform
		}
		if in.Overrides.Parties != nil {
			c.Parties = *in.Overrides.Parties
		}
		if in.Overrides.DataProviderTerms != nil {
			c.DataProviderTerms = *in.Overrides.DataProviderTerms
		}
		if in.Overrides.ApplicationProviderTerms != nil {
			c.ApplicationProviderTerms = *in.Overrides.ApplicationProviderTerms
		}
		if in.Overrides.ConsumerTerms != nil {
			c.ConsumerTerms = *in.Overrides.ConsumerTerms
		}
	}

	if err := contract.SignWithKeycloakSession(&c, claims, secret); err != nil {
		panic(err)
	}

	out, _ := json.MarshalIndent(c, "", "  ")
	fmt.Println(string(out))
}
