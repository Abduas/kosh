package main

import (
	"context"
	"io"
	"log"
	"os"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Files people add (photos and PDFs of vehicle papers) live in the
// project's bucket, connected in Sideyard's Storage tab; SQLite only keeps
// their key, name, type and size. The bucket stays private: the app streams
// files to the phone, which keeps copies of current papers for offline use.
//
// Without a bucket Kosh still works: documents keep their dates and details,
// just not a copy of the file.

type bucket struct {
	name   string
	client *s3.Client
}

var (
	bucketOnce sync.Once
	theBucket  *bucket
)

// fileBucket returns the connected bucket, or nil when there isn't one.
func fileBucket() *bucket {
	bucketOnce.Do(func() {
		name := os.Getenv("S3_BUCKET")
		if name == "" {
			return
		}
		cfg, err := config.LoadDefaultConfig(context.Background(),
			// Some S3-compatible services reject the checksums newer SDKs send.
			config.WithRequestChecksumCalculation(aws.RequestChecksumCalculationWhenRequired),
			config.WithResponseChecksumValidation(aws.ResponseChecksumValidationWhenRequired),
		)
		if err != nil {
			log.Printf("storage: %v", err)
			return
		}
		endpoint := os.Getenv("AWS_ENDPOINT_URL_S3")
		client := s3.NewFromConfig(cfg, func(o *s3.Options) {
			if endpoint != "" && !strings.Contains(endpoint, "amazonaws.com") {
				o.UsePathStyle = true
			}
		})
		theBucket = &bucket{name: name, client: client}
	})
	return theBucket
}

// put streams body to key without holding it all in memory.
func (b *bucket) put(ctx context.Context, key, contentType string, body io.Reader) error {
	_, err := manager.NewUploader(b.client, func(u *manager.Uploader) {
		u.PartSize = 5 << 20
		u.Concurrency = 1
	}).Upload(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(b.name),
		Key:         aws.String(key),
		Body:        body,
		ContentType: aws.String(contentType),
	})
	return err
}

// get opens key for reading; the caller closes it.
func (b *bucket) get(ctx context.Context, key string) (io.ReadCloser, int64, error) {
	out, err := b.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(b.name), Key: aws.String(key)})
	if err != nil {
		return nil, 0, err
	}
	return out.Body, aws.ToInt64(out.ContentLength), nil
}

func (b *bucket) remove(ctx context.Context, key string) error {
	_, err := b.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(b.name), Key: aws.String(key)})
	return err
}

// asciiName keeps a file name safe inside a Content-Disposition header.
func asciiName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_', r == ' ':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "document"
	}
	return b.String()
}
