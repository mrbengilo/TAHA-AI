package handlers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"gosporty-backend/database"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

const (
	websiteProductSchema       = "taha.website.product.v1"
	websiteProductOperation    = "upsert_product"
	websiteProductMaxBody      = 3 << 20
	websiteProductMaxImageSize = 300_000
	websiteProductMaxDimension = 12_000
	websiteProductMaxPixels    = 40_000_000
	websiteProductLease        = 90 * time.Second
	websiteProductMediaDir     = "/data/taha-media"
)

var (
	websiteProductSKU  = regexp.MustCompile(`^[A-Z0-9][A-Z0-9._-]{0,63}$`)
	websiteProductSlug = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
)

type websiteProductMedia struct {
	Role       string `json:"role"`
	SortOrder  int    `json:"sortOrder"`
	Filename   string `json:"filename"`
	MimeType   string `json:"mimeType"`
	DataBase64 string `json:"dataBase64"`
}

type websiteProductInput struct {
	SKU              string                `json:"sku"`
	Name             string                `json:"name"`
	Slug             string                `json:"slug"`
	IsSecondHand     bool                  `json:"isSecondHand"`
	Brand            string                `json:"brand"`
	Category         string                `json:"category"`
	Subcategory      *string               `json:"subcategory"`
	Price            int64                 `json:"price"`
	OriginalPrice    int64                 `json:"originalPrice"`
	CostPrice        int64                 `json:"costPrice"`
	Discount         int                   `json:"discount"`
	Stock            int                   `json:"stock"`
	Colors           []string              `json:"colors"`
	Gifts            []string              `json:"gifts"`
	Sizes            []string              `json:"sizes"`
	ShortDescription string                `json:"shortDescription"`
	Description      string                `json:"description"`
	Specifications   map[string]string     `json:"specifications"`
	Media            []websiteProductMedia `json:"media"`
	Rating           *float64              `json:"rating,omitempty"`
	ReviewCount      *int                  `json:"reviewCount,omitempty"`
	SoldCount        *int64                `json:"soldCount,omitempty"`
}

type websiteProductSource struct {
	System       string `json:"system"`
	DraftID      string `json:"draftId"`
	DraftVersion int    `json:"draftVersion"`
}

type websiteProductPayload struct {
	SchemaVersion  string               `json:"schemaVersion"`
	Operation      string               `json:"operation"`
	TAHAJobID      string               `json:"tahaJobId"`
	IdempotencyKey string               `json:"idempotencyKey"`
	Product        websiteProductInput  `json:"product"`
	Source         websiteProductSource `json:"source"`
}

type validatedWebsiteProductMedia struct {
	data []byte
	name string
}

type websiteProductReceipt struct {
	ID            string             `bson:"_id"`
	SKU           string             `bson:"sku"`
	PayloadDigest string             `bson:"payloadDigest"`
	ProductID     primitive.ObjectID `bson:"productId"`
	Slug          string             `bson:"slug"`
	State         string             `bson:"state"`
	Owner         string             `bson:"owner"`
	StatusCode    int                `bson:"statusCode"`
	CreatedAt     primitive.DateTime `bson:"createdAt"`
	UpdatedAt     primitive.DateTime `bson:"updatedAt"`
}

type websiteProductReservation struct {
	owner  string
	replay *websiteProductReceipt
}

type websiteProductHTTPError struct {
	status     int
	message    string
	retryAfter int
}

func (e *websiteProductHTTPError) Error() string { return e.message }

func productRequestError(status int, message string) error {
	return &websiteProductHTTPError{status: status, message: message}
}

// tryPublishWebsiteProduct is called by PublishWebsiteArticle after that handler
// has read the raw body, verified its HMAC, and validated the idempotency header.
// A body without schemaVersion belongs to the legacy website_article handler.
func tryPublishWebsiteProduct(w http.ResponseWriter, r *http.Request, body []byte, idempotencyKey string) bool {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(body, &probe); err != nil {
		return false
	}
	rawVersion, hasVersion := probe["schemaVersion"]
	if !hasVersion {
		return false
	}
	var version string
	if err := json.Unmarshal(rawVersion, &version); err != nil || version != websiteProductSchema {
		writeWebsiteProductError(w, productRequestError(http.StatusUnprocessableEntity, "unsupported schema version"))
		return true
	}

	if len(body) > websiteProductMaxBody {
		writeWebsiteProductError(w, productRequestError(http.StatusRequestEntityTooLarge, "product payload too large"))
		return true
	}
	payload, media, err := decodeWebsiteProductPayload(body, idempotencyKey)
	if err != nil {
		writeWebsiteProductError(w, err)
		return true
	}
	if err := publishWebsiteProduct(w, r, body, payload, media); err != nil {
		writeWebsiteProductError(w, err)
	}
	return true
}

func decodeWebsiteProductPayload(body []byte, headerKey string) (websiteProductPayload, []validatedWebsiteProductMedia, error) {
	var rawTop map[string]json.RawMessage
	if err := json.Unmarshal(body, &rawTop); err != nil {
		return websiteProductPayload{}, nil, productRequestError(http.StatusBadRequest, "invalid json")
	}
	if err := requireJSONFields(rawTop, "schemaVersion", "operation", "tahaJobId", "idempotencyKey", "product", "source"); err != nil {
		return websiteProductPayload{}, nil, err
	}
	var rawProduct map[string]json.RawMessage
	if err := json.Unmarshal(rawTop["product"], &rawProduct); err != nil {
		return websiteProductPayload{}, nil, productRequestError(http.StatusBadRequest, "product must be an object")
	}
	if err := requireJSONFields(rawProduct,
		"sku", "name", "slug", "isSecondHand", "brand", "category", "subcategory",
		"price", "originalPrice", "costPrice", "discount", "stock", "colors", "gifts",
		"sizes", "shortDescription", "description", "specifications", "media"); err != nil {
		return websiteProductPayload{}, nil, err
	}
	var rawSource map[string]json.RawMessage
	if err := json.Unmarshal(rawTop["source"], &rawSource); err != nil {
		return websiteProductPayload{}, nil, productRequestError(http.StatusBadRequest, "source must be an object")
	}
	if err := requireJSONFields(rawSource, "system", "draftId", "draftVersion"); err != nil {
		return websiteProductPayload{}, nil, err
	}

	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var payload websiteProductPayload
	if err := decoder.Decode(&payload); err != nil {
		return websiteProductPayload{}, nil, productRequestError(http.StatusBadRequest, "invalid product payload")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return websiteProductPayload{}, nil, productRequestError(http.StatusBadRequest, "invalid product payload")
	}
	if payload.SchemaVersion != websiteProductSchema || payload.Operation != websiteProductOperation {
		return websiteProductPayload{}, nil, productRequestError(http.StatusUnprocessableEntity, "unsupported product operation")
	}
	if payload.IdempotencyKey != headerKey || headerKey == "" || len(headerKey) > 180 {
		return websiteProductPayload{}, nil, productRequestError(http.StatusConflict, "idempotency key mismatch")
	}
	if err := validateWebsiteProductPayload(&payload); err != nil {
		return websiteProductPayload{}, nil, err
	}
	media, err := validateWebsiteProductMedia(payload.Product.Media)
	if err != nil {
		return websiteProductPayload{}, nil, err
	}
	return payload, media, nil
}

func requireJSONFields(value map[string]json.RawMessage, names ...string) error {
	for _, name := range names {
		if _, ok := value[name]; !ok {
			return productRequestError(http.StatusBadRequest, "missing required field: "+name)
		}
	}
	return nil
}

func validateWebsiteProductPayload(payload *websiteProductPayload) error {
	p := &payload.Product
	if payload.TAHAJobID != strings.TrimSpace(payload.TAHAJobID) || !validText(payload.TAHAJobID, 1, 200) {
		return productRequestError(http.StatusBadRequest, "invalid tahaJobId")
	}
	if payload.Source.System != "TAHA-AI" || payload.Source.DraftID != strings.TrimSpace(payload.Source.DraftID) ||
		!validText(payload.Source.DraftID, 1, 200) || payload.Source.DraftVersion < 1 {
		return productRequestError(http.StatusBadRequest, "invalid source")
	}
	if p.SKU != strings.TrimSpace(p.SKU) || !websiteProductSKU.MatchString(p.SKU) {
		return productRequestError(http.StatusBadRequest, "invalid product sku")
	}
	if p.Name != strings.TrimSpace(p.Name) || !validText(p.Name, 1, 300) ||
		p.Slug != strings.TrimSpace(p.Slug) || len(p.Slug) > 220 || !websiteProductSlug.MatchString(p.Slug) {
		return productRequestError(http.StatusBadRequest, "invalid product identity")
	}
	if p.Brand != strings.TrimSpace(p.Brand) || !validText(p.Brand, 0, 200) ||
		p.Category != strings.TrimSpace(p.Category) || !validText(p.Category, 1, 200) {
		return productRequestError(http.StatusBadRequest, "invalid product classification")
	}
	if p.Subcategory != nil {
		trimmed := strings.TrimSpace(*p.Subcategory)
		if trimmed != *p.Subcategory || !validText(trimmed, 0, 200) {
			return productRequestError(http.StatusBadRequest, "invalid product subcategory")
		}
	}
	if p.Price < 0 || p.OriginalPrice < p.Price || p.CostPrice < 0 || p.Discount < 0 || p.Discount > 100 || p.Stock < 0 {
		return productRequestError(http.StatusBadRequest, "invalid product pricing or stock")
	}
	if p.Description != strings.TrimSpace(p.Description) || !validText(p.Description, 1, 20000) ||
		p.ShortDescription != strings.TrimSpace(p.ShortDescription) || !validText(p.ShortDescription, 0, 5000) {
		return productRequestError(http.StatusBadRequest, "invalid product description")
	}
	if p.Colors == nil || p.Gifts == nil || p.Sizes == nil || p.Specifications == nil {
		return productRequestError(http.StatusBadRequest, "missing product attributes")
	}
	if err := validateStringList(p.Colors, 30, 160, false); err != nil {
		return productRequestError(http.StatusBadRequest, "invalid product colors")
	}
	if err := validateStringList(p.Gifts, 20, 160, false); err != nil {
		return productRequestError(http.StatusBadRequest, "invalid product gifts")
	}
	if err := validateStringList(p.Sizes, 30, 160, true); err != nil {
		return productRequestError(http.StatusBadRequest, "invalid product sizes")
	}
	if len(p.Specifications) > 80 {
		return productRequestError(http.StatusBadRequest, "too many product specifications")
	}
	for key, value := range p.Specifications {
		if key != strings.TrimSpace(key) || value != strings.TrimSpace(value) || !validText(key, 1, 100) || !validText(value, 1, 300) {
			return productRequestError(http.StatusBadRequest, "invalid product specifications")
		}
	}
	if p.Rating != nil && (*p.Rating < 0 || *p.Rating > 5) {
		return productRequestError(http.StatusBadRequest, "invalid product rating")
	}
	if p.ReviewCount != nil && *p.ReviewCount < 0 || p.SoldCount != nil && *p.SoldCount < 0 {
		return productRequestError(http.StatusBadRequest, "invalid product counters")
	}
	return nil
}

func validText(value string, minRunes, maxRunes int) bool {
	if !utf8.ValidString(value) {
		return false
	}
	length := utf8.RuneCountInString(value)
	return length >= minRunes && length <= maxRunes
}

func validateStringList(values []string, maxItems, maxRunes int, requireOne bool) error {
	if len(values) > maxItems || requireOne && len(values) == 0 {
		return errors.New("invalid list length")
	}
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value != strings.TrimSpace(value) || !validText(value, 1, maxRunes) {
			return errors.New("invalid list value")
		}
		if _, ok := seen[value]; ok {
			return errors.New("duplicate list value")
		}
		seen[value] = struct{}{}
	}
	return nil
}

func validateWebsiteProductMedia(items []websiteProductMedia) ([]validatedWebsiteProductMedia, error) {
	if len(items) == 0 {
		return nil, productRequestError(http.StatusBadRequest, "product must contain at least one image")
	}
	result := make([]validatedWebsiteProductMedia, 0, len(items))
	for index, item := range items {
		expectedRole := "gallery"
		if index == 0 {
			expectedRole = "primary"
		}
		if item.Role != expectedRole || item.SortOrder != index || item.MimeType != "image/jpeg" {
			return nil, productRequestError(http.StatusBadRequest, "invalid product media metadata")
		}
		if item.Filename != filepath.Base(item.Filename) || !validText(item.Filename, 1, 180) || strings.ContainsAny(item.Filename, "\r\n\x00") {
			return nil, productRequestError(http.StatusBadRequest, "invalid product media filename")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(item.DataBase64)
		if err != nil || len(data) == 0 || len(data) >= websiteProductMaxImageSize {
			return nil, productRequestError(http.StatusBadRequest, "invalid product media payload")
		}
		config, err := jpeg.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width < 1 || config.Height < 1 ||
			config.Width > websiteProductMaxDimension || config.Height > websiteProductMaxDimension ||
			int64(config.Width)*int64(config.Height) > websiteProductMaxPixels {
			return nil, productRequestError(http.StatusBadRequest, "product media is not a valid JPEG")
		}
		hash := sha256.Sum256(data)
		result = append(result, validatedWebsiteProductMedia{data: data, name: hex.EncodeToString(hash[:]) + ".jpg"})
	}
	return result, nil
}

func publishWebsiteProduct(w http.ResponseWriter, r *http.Request, body []byte, payload websiteProductPayload, media []validatedWebsiteProductMedia) error {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	products := database.DB.Collection("products")
	receipts := database.DB.Collection("taha_product_receipts")

	productID, existed, err := resolveWebsiteProductID(ctx, products, payload.Product.SKU)
	if err != nil {
		var requestError *websiteProductHTTPError
		if errors.As(err, &requestError) {
			return err
		}
		return productRequestError(http.StatusInternalServerError, "database unavailable")
	}
	digestBytes := sha256.Sum256(body)
	digest := hex.EncodeToString(digestBytes[:])
	reservation, err := reserveWebsiteProductReceipt(ctx, receipts, payload.IdempotencyKey, payload.Product.SKU, digest, productID)
	if err != nil {
		return err
	}
	if reservation.replay != nil {
		respondWithWebsiteProduct(w, reservation.replay.ProductID, reservation.replay.Slug, http.StatusOK)
		return nil
	}
	completed := false
	defer func() {
		if completed {
			return
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cleanupCancel()
		_, _ = receipts.DeleteOne(cleanupCtx, bson.M{"_id": payload.IdempotencyKey, "owner": reservation.owner, "state": "processing"})
	}()

	imagePaths, err := saveWebsiteProductMedia(websiteProductMediaDir, media)
	if err != nil {
		return productRequestError(http.StatusInternalServerError, "media storage unavailable")
	}
	created, err := upsertWebsiteProduct(ctx, products, productID, existed, payload, imagePaths)
	if err != nil {
		return err
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	now := primitive.NewDateTimeFromTime(time.Now().UTC())
	result, err := receipts.UpdateOne(ctx,
		bson.M{"_id": payload.IdempotencyKey, "owner": reservation.owner, "state": "processing"},
		bson.M{"$set": bson.M{"state": "succeeded", "slug": payload.Product.Slug, "statusCode": status, "updatedAt": now}, "$unset": bson.M{"owner": ""}},
	)
	if err != nil || result.MatchedCount != 1 {
		return productRequestError(http.StatusInternalServerError, "could not store product receipt")
	}
	completed = true
	go PingGoogleSitemap()
	respondWithWebsiteProduct(w, productID, payload.Product.Slug, status)
	return nil
}

func resolveWebsiteProductID(ctx context.Context, products *mongo.Collection, sku string) (primitive.ObjectID, bool, error) {
	type productIdentity struct {
		ID primitive.ObjectID `bson:"_id"`
	}
	boundary := websiteProductLegacySKURegex(sku)
	filter := bson.M{"$or": bson.A{
		bson.M{"sku": sku},
		bson.M{"name": bson.M{"$regex": boundary, "$options": "i"}},
		bson.M{"slug": bson.M{"$regex": boundary, "$options": "i"}},
	}}
	cursor, err := products.Find(ctx, filter, options.Find().SetProjection(bson.M{"_id": 1}).SetLimit(2))
	if err != nil {
		return primitive.NilObjectID, false, err
	}
	defer cursor.Close(ctx)
	var matches []productIdentity
	if err := cursor.All(ctx, &matches); err != nil {
		return primitive.NilObjectID, false, err
	}
	if len(matches) > 1 {
		return primitive.NilObjectID, false, productRequestError(http.StatusConflict, "multiple existing products contain this SKU")
	}
	if len(matches) == 1 {
		return matches[0].ID, true, nil
	}
	return websiteProductObjectID(sku), false, nil
}

func websiteProductObjectID(sku string) primitive.ObjectID {
	sum := sha256.Sum256([]byte("taha-product-sku-v1\x00" + sku))
	var id primitive.ObjectID
	copy(id[:], sum[:len(id)])
	return id
}

func websiteProductLegacySKURegex(sku string) string {
	return "(^|[^A-Za-z0-9])" + regexp.QuoteMeta(sku) + "([^A-Za-z0-9]|$)"
}

func reserveWebsiteProductReceipt(ctx context.Context, receipts *mongo.Collection, key, sku, digest string, productID primitive.ObjectID) (websiteProductReservation, error) {
	now := time.Now().UTC()
	owner := primitive.NewObjectID().Hex()
	receipt := websiteProductReceipt{
		ID: key, SKU: sku, PayloadDigest: digest, ProductID: productID,
		State: "processing", Owner: owner,
		CreatedAt: primitive.NewDateTimeFromTime(now), UpdatedAt: primitive.NewDateTimeFromTime(now),
	}
	if _, err := receipts.InsertOne(ctx, receipt); err == nil {
		return websiteProductReservation{owner: owner}, nil
	} else if !mongo.IsDuplicateKeyError(err) {
		return websiteProductReservation{}, productRequestError(http.StatusInternalServerError, "database unavailable")
	}

	var existing websiteProductReceipt
	if err := receipts.FindOne(ctx, bson.M{"_id": key}).Decode(&existing); err != nil {
		return websiteProductReservation{}, productRequestError(http.StatusInternalServerError, "database unavailable")
	}
	if existing.SKU != sku || existing.PayloadDigest != digest || existing.ProductID != productID {
		return websiteProductReservation{}, productRequestError(http.StatusConflict, "idempotency key already belongs to another request")
	}
	if existing.State == "succeeded" {
		return websiteProductReservation{replay: &existing}, nil
	}
	cutoff := primitive.NewDateTimeFromTime(now.Add(-websiteProductLease))
	updated := primitive.NewDateTimeFromTime(now)
	result := receipts.FindOneAndUpdate(ctx,
		bson.M{"_id": key, "sku": sku, "payloadDigest": digest, "productId": productID, "state": "processing", "updatedAt": bson.M{"$lt": cutoff}},
		bson.M{"$set": bson.M{"owner": owner, "updatedAt": updated}},
		options.FindOneAndUpdate().SetReturnDocument(options.After),
	)
	var claimed websiteProductReceipt
	if err := result.Decode(&claimed); err == nil {
		return websiteProductReservation{owner: owner}, nil
	} else if !errors.Is(err, mongo.ErrNoDocuments) {
		return websiteProductReservation{}, productRequestError(http.StatusInternalServerError, "database unavailable")
	}
	return websiteProductReservation{}, &websiteProductHTTPError{status: http.StatusServiceUnavailable, message: "matching request is already processing", retryAfter: 2}
}

func upsertWebsiteProduct(ctx context.Context, products *mongo.Collection, productID primitive.ObjectID, existed bool, payload websiteProductPayload, images []string) (bool, error) {
	p := payload.Product
	var slugOwner struct {
		ID primitive.ObjectID `bson:"_id"`
	}
	err := products.FindOne(ctx, bson.M{"slug": p.Slug, "_id": bson.M{"$ne": productID}}, options.FindOne().SetProjection(bson.M{"_id": 1})).Decode(&slugOwner)
	if err == nil {
		return false, productRequestError(http.StatusConflict, "product slug belongs to another product")
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return false, productRequestError(http.StatusInternalServerError, "database unavailable")
	}

	now := primitive.NewDateTimeFromTime(time.Now().UTC())
	set, setOnInsert := websiteProductUpdateDocuments(payload, images, now)
	update := bson.M{"$set": set, "$setOnInsert": setOnInsert}
	filter := bson.M{"_id": productID, "$or": bson.A{bson.M{"sku": p.SKU}, bson.M{"sku": bson.M{"$exists": false}}}}
	result, err := products.UpdateOne(ctx, filter, update, options.Update().SetUpsert(true))
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return false, productRequestError(http.StatusConflict, "product identity belongs to another SKU")
		}
		return false, productRequestError(http.StatusInternalServerError, "could not store product")
	}
	created := result.UpsertedCount == 1
	if existed && created {
		return false, productRequestError(http.StatusConflict, "product SKU changed during update")
	}
	return created, nil
}

func websiteProductUpdateDocuments(payload websiteProductPayload, images []string, now primitive.DateTime) (bson.M, bson.M) {
	p := payload.Product
	colors := make([]bson.M, 0, len(p.Colors))
	for _, color := range p.Colors {
		colors = append(colors, bson.M{"name": color})
	}
	subcategory := ""
	if p.Subcategory != nil {
		subcategory = *p.Subcategory
	}
	set := bson.M{
		"sku": p.SKU, "tahaJobId": payload.TAHAJobID,
		"tahaSource": bson.M{"system": payload.Source.System, "draftId": payload.Source.DraftID, "draftVersion": payload.Source.DraftVersion},
		"name": p.Name, "shortDescription": p.ShortDescription, "description": p.Description,
		"price": p.Price, "costPrice": p.CostPrice, "originalPrice": p.OriginalPrice, "discount": p.Discount,
		"image": images[0], "images": images, "category": p.Category, "subcategory": subcategory,
		"brand": p.Brand, "slug": p.Slug, "stock": p.Stock, "colors": colors, "sizes": p.Sizes,
		"specifications": p.Specifications, "gifts": p.Gifts, "isSecondHand": p.IsSecondHand, "updatedAt": now,
	}
	if p.Rating != nil {
		set["rating"] = *p.Rating
	}
	if p.ReviewCount != nil {
		set["reviewCount"] = *p.ReviewCount
	}
	if p.SoldCount != nil {
		set["soldCount"] = *p.SoldCount
	}
	setOnInsert := bson.M{
		"createdAt": now, "favoriteCount": int64(0), "isHidden": false,
	}
	if p.Rating == nil {
		setOnInsert["rating"] = float64(0)
	}
	if p.ReviewCount == nil {
		setOnInsert["reviewCount"] = 0
	}
	if p.SoldCount == nil {
		setOnInsert["soldCount"] = int64(0)
	}
	return set, setOnInsert
}

func saveWebsiteProductMedia(directory string, media []validatedWebsiteProductMedia) ([]string, error) {
	if err := os.MkdirAll(directory, 0755); err != nil {
		return nil, err
	}
	result := make([]string, 0, len(media))
	for _, item := range media {
		finalPath := filepath.Join(directory, item.name)
		if err := writeWebsiteProductFileAtomic(directory, finalPath, item.data); err != nil {
			return nil, err
		}
		result = append(result, "/uploads/taha/"+item.name)
	}
	return result, nil
}

func writeWebsiteProductFileAtomic(directory, finalPath string, data []byte) error {
	if existing, err := os.ReadFile(finalPath); err == nil {
		if bytes.Equal(existing, data) {
			return nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".taha-product-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := writeWebsiteProductTemporary(temporary, data); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, finalPath); err != nil {
		return err
	}
	directoryHandle, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer directoryHandle.Close()
	return directoryHandle.Sync()
}

type websiteProductTemporaryFile interface {
	io.WriteCloser
	Chmod(os.FileMode) error
	Sync() error
}

// Complete and close the temporary file before it can replace public media.
// Close still runs after a failure, but must not hide the first I/O error.
func writeWebsiteProductTemporary(temporary websiteProductTemporaryFile, data []byte) error {
	err := temporary.Chmod(0644)
	if err == nil {
		var written int
		written, err = temporary.Write(data)
		if err == nil && written != len(data) {
			err = io.ErrShortWrite
		}
	}
	if err == nil {
		err = temporary.Sync()
	}
	closeErr := temporary.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func respondWithWebsiteProduct(w http.ResponseWriter, id primitive.ObjectID, _ string, status int) {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("PUBLIC_SITE_URL")), "/")
	if base == "" {
		base = "https://tahashoes.vn"
	}
	writeJSON(w, status, map[string]any{"id": id.Hex(), "url": base + "/product/" + id.Hex()})
}

func writeWebsiteProductError(w http.ResponseWriter, err error) {
	var requestError *websiteProductHTTPError
	if !errors.As(err, &requestError) {
		requestError = &websiteProductHTTPError{status: http.StatusInternalServerError, message: "could not publish product"}
	}
	if requestError.retryAfter > 0 {
		w.Header().Set("Retry-After", fmt.Sprint(requestError.retryAfter))
	}
	http.Error(w, requestError.message, requestError.status)
}
