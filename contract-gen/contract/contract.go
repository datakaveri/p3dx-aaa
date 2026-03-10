package contract

import "time"

type Lifecycle struct {
	CreatedAt  time.Time `json:"created_at"`
	ValidFrom  time.Time `json:"valid_from"`
	ValidUntil time.Time `json:"valid_until"`
}

type Party struct {
	ID             string `json:"id,omitempty"`
	Name           string `json:"name"`
	OrganizationID string `json:"organization_id,omitempty"`
	PublicKey      string `json:"public_key"`
}

type Parties struct {
	DataProvider        Party `json:"data_provider"`
	ApplicationProvider Party `json:"application_provider"`
	Consumer            Party `json:"consumer"`
}

type Constraints struct {
	AccessibilityLevel string `json:"accessibility_level,omitempty"`
	Restricted         string `json:"restricted,omitempty"`
}

type UsageConstraints struct {
	MaxRequests  int    `json:"max_requests,omitempty"`
	MaxBatchSize int    `json:"max_batch_size,omitempty"`
	ResultFormat string `json:"result_format,omitempty"`
}

type DataProviderTerms struct {
	DataResourceID string      `json:"data_resource_id"`
	DatasetName    string      `json:"dataset_name"`
	DatasetVersion string      `json:"dataset_version"`
	DataURL        string      `json:"data_url"`
	DataHash       string      `json:"data_hash"`
	Format         string      `json:"format"`
	DataSizeBytes  int64       `json:"data_size_bytes"`
	LicenseType    string      `json:"license_type"`
	Constraints    Constraints `json:"constraints,omitempty"`
}

type ApplicationProviderTerms struct {
	AppID           string           `json:"app_id"`
	AppName         string           `json:"app_name"`
	AppVersion      string           `json:"app_version"`
	AppHash         string           `json:"app_hash"`
	ContainerImage  string           `json:"container_image"`
	ContainerDigest string           `json:"container_digest"`
	Constraints     Constraints      `json:"constraints,omitempty"`
	Usage           UsageConstraints `json:"usage_constraints,omitempty"`
}

type ConsumerTerms struct {
	SelectedAppID      string           `json:"selected_app_id"`
	SelectedAppVersion string           `json:"selected_app_version"`
	DataBlobURL        string           `json:"datablob_url"`
	UsageConstraints   UsageConstraints `json:"usage_constraints,omitempty"`
	DataRetention      string           `json:"consumer_data_retention_policy,omitempty"`
}

type SignatureTimes struct {
	DataProvider        *time.Time `json:"data_provider,omitempty"`
	ApplicationProvider *time.Time `json:"application_provider,omitempty"`
	Consumer            *time.Time `json:"consumer,omitempty"`
	APD                 *time.Time `json:"apd,omitempty"`
}

type Signatures struct {
	ContractHash                 string         `json:"contract_hash"`
	SignatureAlgorithm           string         `json:"signature_algorithm"`
	DataProviderSignature        string         `json:"data_provider_signature,omitempty"`
	ApplicationProviderSignature string         `json:"application_provider_signature,omitempty"`
	ConsumerSignature            string         `json:"consumer_signature,omitempty"`
	APDSignature                 string         `json:"apd_signature,omitempty"`
	SignedAt                     SignatureTimes `json:"signed_at"`
}

type Contract struct {
	ContractID               string                   `json:"contract_id"`
	Version                  int                      `json:"version"`
	Description              string                   `json:"description"`
	Lifecycle                Lifecycle                `json:"lifecycle"`
	ExecutionType            string                   `json:"execution_type"`
	ExecutionPlatform        string                   `json:"execution_platform"`
	Parties                  Parties                  `json:"parties"`
	DataProviderTerms        DataProviderTerms        `json:"data_provider_terms"`
	ApplicationProviderTerms ApplicationProviderTerms `json:"application_provider_terms"`
	ConsumerTerms            ConsumerTerms            `json:"consumer_terms"`
	Signatures               Signatures               `json:"signatures"`
}
