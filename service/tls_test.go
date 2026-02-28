package main

import (
	"crypto/x509"
	"encoding/pem"
	"net"
	"os"
	"testing"
	"time"
)

func chdir(t *testing.T, dir string) {
	t.Helper()
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(old) })
}

func TestGetOrCreateCert_Generate(t *testing.T) {
	chdir(t, t.TempDir())

	cert, err := getOrCreateCert()
	if err != nil {
		t.Fatalf("getOrCreateCert: %v", err)
	}
	if len(cert.Certificate) == 0 {
		t.Fatal("empty certificate chain")
	}

	// Verify files were created
	if _, err := os.Stat(certFile); err != nil {
		t.Fatalf("cert.pem not created: %v", err)
	}
	if _, err := os.Stat(keyFile); err != nil {
		t.Fatalf("key.pem not created: %v", err)
	}

	// Parse and verify cert attributes
	x509Cert, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatalf("parse cert: %v", err)
	}

	if x509Cert.Subject.CommonName != "videochat" {
		t.Fatalf("expected CN=videochat, got %q", x509Cert.Subject.CommonName)
	}

	foundLocalhost := false
	for _, dns := range x509Cert.DNSNames {
		if dns == "localhost" {
			foundLocalhost = true
		}
	}
	if !foundLocalhost {
		t.Fatal("cert should include localhost in DNSNames")
	}

	foundLoopback := false
	for _, ip := range x509Cert.IPAddresses {
		if ip.Equal(net.ParseIP("127.0.0.1")) {
			foundLoopback = true
		}
	}
	if !foundLoopback {
		t.Fatal("cert should include 127.0.0.1 in IPAddresses")
	}

	// Validity should be roughly 2 years
	validity := x509Cert.NotAfter.Sub(x509Cert.NotBefore)
	if validity < 729*24*time.Hour || validity > 731*24*time.Hour {
		t.Fatalf("expected ~2 year validity, got %v", validity)
	}

	// Check file permissions
	info, _ := os.Stat(certFile)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("expected cert.pem perms 0600, got %o", info.Mode().Perm())
	}
}

func TestGetOrCreateCert_LoadExisting(t *testing.T) {
	chdir(t, t.TempDir())

	// Generate
	cert1, err := getOrCreateCert()
	if err != nil {
		t.Fatal(err)
	}
	x509Cert1, _ := x509.ParseCertificate(cert1.Certificate[0])
	serial1 := x509Cert1.SerialNumber

	// Load existing
	cert2, err := getOrCreateCert()
	if err != nil {
		t.Fatal(err)
	}
	x509Cert2, _ := x509.ParseCertificate(cert2.Certificate[0])
	serial2 := x509Cert2.SerialNumber

	if serial1.Cmp(serial2) != 0 {
		t.Fatal("second call should load existing cert (same serial)")
	}
}

func TestGetOrCreateCert_RegenerateOnCorrupt(t *testing.T) {
	chdir(t, t.TempDir())

	os.WriteFile(certFile, []byte("garbage"), 0600)
	os.WriteFile(keyFile, []byte("garbage"), 0600)

	cert, err := getOrCreateCert()
	if err != nil {
		t.Fatalf("should regenerate on corrupt files: %v", err)
	}

	// Verify it's a valid cert
	x509Cert, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if x509Cert.Subject.CommonName != "videochat" {
		t.Fatalf("expected CN=videochat, got %q", x509Cert.Subject.CommonName)
	}

	// Verify files were overwritten with valid PEM
	data, _ := os.ReadFile(certFile)
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		t.Fatal("cert.pem should contain valid PEM CERTIFICATE")
	}
}
