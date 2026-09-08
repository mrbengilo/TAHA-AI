package handlers

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
)

func testWebsiteProductJPEG(t *testing.T) []byte {
	t.Helper()
	value := image.NewRGBA(image.Rect(0, 0, 2, 2))
	value.Set(0, 0, color.RGBA{R: 255, A: 255})
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, value, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

func testWebsiteProductBody(t *testing.T, imageCount int) []byte {
	t.Helper()
	encoded := base64.StdEncoding.EncodeToString(testWebsiteProductJPEG(t))
	media := make([]map[string]any, imageCount)
	for index := range media {
		role := "gallery"
		if index == 0 {
			role = "primary"
		}
		media[index] = map[string]any{
			"role": role, "sortOrder": index, "filename": "PH0015-" + strconv.Itoa(index+1) + ".jpg",
			"mimeType": "image/jpeg", "dataBase64": encoded,
		}
	}
	payload := map[string]any{
		"schemaVersion": websiteProductSchema,
		"operation": websiteProductOperation,
		"tahaJobId": "job-PH0015-1",
		"idempotencyKey": "publish-PH0015-v1",
		"product": map[string]any{
			"sku": "PH0015", "name": "Giày chạy bộ - PH0015", "slug": "giay-chay-bo-ph0015",
			"isSecondHand": false, "brand": "LITUO SPORT", "category": "Giày chạy bộ", "subcategory": nil,
			"price": 619000, "originalPrice": 990000, "costPrice": 250000, "discount": 37, "stock": 12,
			"colors": []string{"Trắng"}, "gifts": []string{}, "sizes": []string{"36", "37"},
			"shortDescription": "• Thân giày thoáng nhẹ", "description": "Thông tin sản phẩm PH0015",
			"specifications": map[string]string{"Chất liệu": "mesh"}, "media": media,
		},
		"source": map[string]any{"system": "TAHA-AI", "draftId": "draft-1", "draftVersion": 1},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestDecodeWebsiteProductPayloadAcceptsSixStrictJPEGs(t *testing.T) {
	payload, media, err := decodeWebsiteProductPayload(testWebsiteProductBody(t, 6), "publish-PH0015-v1")
	if err != nil {
		t.Fatal(err)
	}
	if payload.Product.SKU != "PH0015" || len(media) != 6 {
		t.Fatalf("unexpected product: sku=%q media=%d", payload.Product.SKU, len(media))
	}
	if payload.Product.Rating != nil || payload.Product.ReviewCount != nil || payload.Product.SoldCount != nil {
		t.Fatal("owner counters must remain absent")
	}
}

func TestDecodeWebsiteProductPayloadRejectsUnknownFieldAndMismatchedKey(t *testing.T) {
	var value map[string]any
	if err := json.Unmarshal(testWebsiteProductBody(t, 1), &value); err != nil {
		t.Fatal(err)
	}
	value["unexpected"] = true
	body, _ := json.Marshal(value)
	if _, _, err := decodeWebsiteProductPayload(body, "publish-PH0015-v1"); err == nil {
		t.Fatal("expected unknown field to be rejected")
	}
	delete(value, "unexpected")
	body, _ = json.Marshal(value)
	_, _, err := decodeWebsiteProductPayload(body, "another-request-key")
	var requestError *websiteProductHTTPError
	if !errors.As(err, &requestError) || requestError.status != http.StatusConflict {
		t.Fatalf("expected 409 for mismatched key, got %#v", err)
	}
}

func TestValidateWebsiteProductMediaRejectsCountTypeAndSize(t *testing.T) {
	valid := base64.StdEncoding.EncodeToString(testWebsiteProductJPEG(t))
	makeItem := func(index int) websiteProductMedia {
		role := "gallery"
		if index == 0 {
			role = "primary"
		}
		return websiteProductMedia{Role: role, SortOrder: index, Filename: "shoe.jpg", MimeType: "image/jpeg", DataBase64: valid}
	}
	seven := make([]websiteProductMedia, 27)
	for index := range seven {
		seven[index] = makeItem(index)
	}
	if result, err := validateWebsiteProductMedia(seven); err != nil || len(result) != 27 {
		t.Fatal("expected every source image to be accepted")
	}
	if _, err := validateWebsiteProductMedia(nil); err == nil {
		t.Fatal("expected empty gallery to be rejected")
	}
	wrongType := []websiteProductMedia{makeItem(0)}
	wrongType[0].MimeType = "image/png"
	if _, err := validateWebsiteProductMedia(wrongType); err == nil {
		t.Fatal("expected non-JPEG MIME type to be rejected")
	}
	tooLarge := []websiteProductMedia{makeItem(0)}
	tooLarge[0].DataBase64 = base64.StdEncoding.EncodeToString(make([]byte, websiteProductMaxImageSize))
	if _, err := validateWebsiteProductMedia(tooLarge); err == nil {
		t.Fatal("expected a 300,000-byte image to be rejected")
	}
	invalidJPEG := []websiteProductMedia{makeItem(0)}
	invalidJPEG[0].DataBase64 = base64.StdEncoding.EncodeToString([]byte("not a jpeg"))
	if _, err := validateWebsiteProductMedia(invalidJPEG); err == nil {
		t.Fatal("expected invalid JPEG bytes to be rejected")
	}
}

func TestWebsiteProductUpdatePreservesOmittedOwnerCounters(t *testing.T) {
	payload, _, err := decodeWebsiteProductPayload(testWebsiteProductBody(t, 1), "publish-PH0015-v1")
	if err != nil {
		t.Fatal(err)
	}
	now := primitive.NewDateTimeFromTime(time.Unix(123, 0))
	set, setOnInsert := websiteProductUpdateDocuments(payload, []string{"/uploads/taha/one.jpg"}, now)
	for _, field := range []string{"rating", "reviewCount", "soldCount", "favoriteCount", "isHidden", "createdAt"} {
		if _, found := set[field]; found {
			t.Fatalf("owner field %q must not be overwritten", field)
		}
	}
	if setOnInsert["rating"] != float64(0) || setOnInsert["reviewCount"] != 0 || setOnInsert["soldCount"] != int64(0) {
		t.Fatalf("new products need truthful zero counters: %#v", setOnInsert)
	}
	if colors, ok := set["colors"].([]bson.M); !ok || len(colors) != 1 || colors[0]["name"] != "Trắng" {
		t.Fatalf("colors were not mapped to the website model: %#v", set["colors"])
	}
	if set["image"] != "/uploads/taha/one.jpg" {
		t.Fatalf("primary image not mapped: %#v", set["image"])
	}

	rating, reviews, sold := 4.8, 17, int64(29)
	payload.Product.Rating, payload.Product.ReviewCount, payload.Product.SoldCount = &rating, &reviews, &sold
	set, setOnInsert = websiteProductUpdateDocuments(payload, []string{"/uploads/taha/one.jpg"}, now)
	if set["rating"] != 4.8 || set["reviewCount"] != 17 || set["soldCount"] != int64(29) {
		t.Fatalf("explicit owner counters missing: %#v", set)
	}
	for _, field := range []string{"rating", "reviewCount", "soldCount"} {
		if _, found := setOnInsert[field]; found {
			t.Fatalf("field %q cannot appear in both Mongo operators", field)
		}
	}
}

func TestWebsiteProductIdentityIsDeterministicAndLegacyMatchUsesBoundaries(t *testing.T) {
	first := websiteProductObjectID("PH0015")
	if first != websiteProductObjectID("PH0015") {
		t.Fatal("same SKU must have the same product id")
	}
	if first == websiteProductObjectID("PH0016") {
		t.Fatal("different SKUs must not share a product id")
	}
	matcher := regexp.MustCompile("(?i)" + websiteProductLegacySKURegex("PH0015"))
	for _, value := range []string{"Giày chạy bộ - PH0015", "giay-chay-bo-ph0015", "PH0015"} {
		if !matcher.MatchString(value) {
			t.Fatalf("expected exact SKU boundary match for %q", value)
		}
	}
	for _, value := range []string{"XPH0015", "PH00150", "PH0015X"} {
		if matcher.MatchString(value) {
			t.Fatalf("must not match embedded SKU in %q", value)
		}
	}
}

func TestSaveWebsiteProductMediaUsesAtomicContentAddressedFile(t *testing.T) {
	decoded, err := validateWebsiteProductMedia([]websiteProductMedia{{
		Role: "primary", SortOrder: 0, Filename: "PH0015.jpg", MimeType: "image/jpeg",
		DataBase64: base64.StdEncoding.EncodeToString(testWebsiteProductJPEG(t)),
	}})
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	paths, err := saveWebsiteProductMedia(directory, decoded)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || paths[0] != "/uploads/taha/"+decoded[0].name {
		t.Fatalf("unexpected media URL: %#v", paths)
	}
	stored, err := os.ReadFile(filepath.Join(directory, decoded[0].name))
	if err != nil || !bytes.Equal(stored, decoded[0].data) {
		t.Fatal("stored media differs from validated media")
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".taha-product-") {
			t.Fatalf("temporary file was not removed: %s", entry.Name())
		}
	}
	if _, err := saveWebsiteProductMedia(directory, decoded); err != nil {
		t.Fatalf("content-addressed replay failed: %v", err)
	}
}

type failingWebsiteProductTemporaryFile struct {
	chmodErr error
	writeErr error
	syncErr  error
	closeErr error
	short    bool
	calls    []string
}

func (f *failingWebsiteProductTemporaryFile) Chmod(mode os.FileMode) error {
	f.calls = append(f.calls, "chmod")
	if mode != 0644 {
		return errors.New("unexpected public media permission")
	}
	return f.chmodErr
}

func (f *failingWebsiteProductTemporaryFile) Write(data []byte) (int, error) {
	f.calls = append(f.calls, "write")
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	if f.short {
		return len(data) - 1, nil
	}
	return len(data), nil
}

func (f *failingWebsiteProductTemporaryFile) Sync() error {
	f.calls = append(f.calls, "sync")
	return f.syncErr
}

func (f *failingWebsiteProductTemporaryFile) Close() error {
	f.calls = append(f.calls, "close")
	return f.closeErr
}

func TestWebsiteProductTemporaryFileRejectsIOFailuresBeforePublication(t *testing.T) {
	permissionError := errors.New("permission denied")
	writeError := errors.New("no space left on device")
	syncError := errors.New("sync failed")
	closeError := errors.New("close failed")
	tests := []struct {
		name  string
		file  failingWebsiteProductTemporaryFile
		want  error
		calls []string
	}{
		{"chmod", failingWebsiteProductTemporaryFile{chmodErr: permissionError}, permissionError, []string{"chmod", "close"}},
		{"write", failingWebsiteProductTemporaryFile{writeErr: writeError}, writeError, []string{"chmod", "write", "close"}},
		{"short write", failingWebsiteProductTemporaryFile{short: true}, io.ErrShortWrite, []string{"chmod", "write", "close"}},
		{"sync", failingWebsiteProductTemporaryFile{syncErr: syncError}, syncError, []string{"chmod", "write", "sync", "close"}},
		{"close", failingWebsiteProductTemporaryFile{closeErr: closeError}, closeError, []string{"chmod", "write", "sync", "close"}},
		{"preserve first error", failingWebsiteProductTemporaryFile{writeErr: writeError, closeErr: closeError}, writeError, []string{"chmod", "write", "close"}},
		{"success", failingWebsiteProductTemporaryFile{}, nil, []string{"chmod", "write", "sync", "close"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := writeWebsiteProductTemporary(&tt.file, []byte("complete image bytes"))
			if !errors.Is(err, tt.want) {
				t.Fatalf("expected %v, got %v", tt.want, err)
			}
			if !reflect.DeepEqual(tt.file.calls, tt.calls) {
				t.Fatalf("expected I/O sequence %v, got %v", tt.calls, tt.file.calls)
			}
		})
	}
}

func TestWebsiteProductReusesRawBodyHMACAndLegacyDispatch(t *testing.T) {
	body := testWebsiteProductBody(t, 1)
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	secret := "test-receiver-secret"
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(body)

	request := httptest.NewRequest(http.MethodPost, "/api/taha/publish", bytes.NewReader(body))
	request.Header.Set("X-TAHA-Timestamp", timestamp)
	request.Header.Set("X-TAHA-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	if !validWebsiteSignature(request, secret, body) {
		t.Fatal("valid raw-body signature was rejected")
	}
	if validWebsiteSignature(request, secret, append(append([]byte{}, body...), ' ')) {
		t.Fatal("signature must bind the exact raw body")
	}

	legacy := []byte(`{"contentType":"website_article","title":"Legacy","body":"Still supported"}`)
	if tryPublishWebsiteProduct(httptest.NewRecorder(), request, legacy, "legacy-key") {
		t.Fatal("legacy article payload must continue to the existing handler")
	}
	unknown := []byte(`{"schemaVersion":"taha.website.product.v2"}`)
	recorder := httptest.NewRecorder()
	if !tryPublishWebsiteProduct(recorder, request, unknown, "key") || recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown product schema should be handled with 422, got %d", recorder.Code)
	}
}

func TestWebsiteProductReceiptUsesStableRealProductURL(t *testing.T) {
	id := websiteProductObjectID("PH0015")
	t.Setenv("PUBLIC_SITE_URL", "https://tahashoes.vn/")
	recorder := httptest.NewRecorder()
	respondWithWebsiteProduct(recorder, id, "ignored-slug", http.StatusCreated)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("unexpected status: %d", recorder.Code)
	}
	var receipt map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt["id"] != id.Hex() || receipt["url"] != "https://tahashoes.vn/product/"+id.Hex() {
		t.Fatalf("invalid receipt: %#v", receipt)
	}
}
