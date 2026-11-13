package main

import "testing"

func TestParseBankSMS(t *testing.T) {
	cases := []struct {
		name string
		text string
		want bankSMS
	}{
		{"hdfc upi sent", "Sent Rs.250.00\nFrom HDFC Bank A/C *4521\nTo SWIGGY LIMITED\nOn 13/11/25\nRef 531712345678\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808",
			bankSMS{Direction: "debit", Amount: 25000, Last4: "4521", Bank: "HDFC Bank", Merchant: "Swiggy Limited", Ref: "531712345678"}},
		{"hdfc upi credit", "Credit Alert!\nRs.1,500.00 credited to HDFC Bank A/c XX4521 on 13-11-25 from VPA rahul.k@okaxis (UPI 531798765432)",
			bankSMS{Direction: "credit", Amount: 150000, Last4: "4521", Bank: "HDFC Bank", Payee: "rahul.k@okaxis", Merchant: "rahul.k@okaxis", Ref: "531798765432"}},
		{"sbi upi debit", "Dear UPI user A/C X7788 debited by 120.0 on date 13Nov25 trf to RAMESH TEA STALL Refno 531755554444. If not u? call 1800111109. -SBI",
			bankSMS{Direction: "debit", Amount: 12000, Last4: "7788", Bank: "State Bank of India", Merchant: "Ramesh Tea Stall", Ref: "531755554444"}},
		{"sbi credit", "Dear SBI User, your A/c X7788-credited by Rs.5000 on 13Nov25 transfer from ANITA S Ref No 531700001111 -SBI",
			bankSMS{Direction: "credit", Amount: 500000, Last4: "7788", Bank: "State Bank of India", Merchant: "Anita S", Ref: "531700001111"}},
		{"icici debit", "ICICI Bank Acct XX123 debited for Rs 499.00 on 13-Nov-25; Netflix credited. UPI:531722223333. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766.",
			bankSMS{Direction: "debit", Amount: 49900, Last4: "123", Bank: "ICICI Bank", Merchant: "Netflix", Ref: "531722223333"}},
		{"axis debit", "INR 860.00 debited\nA/c no. XX9012\n13-11-25, 19:02:11\nUPI/P2M/531733334444/BIG BAZAAR\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank",
			bankSMS{Direction: "debit", Amount: 86000, Last4: "9012", Bank: "Axis Bank", Merchant: "Big Bazaar", Ref: "531733334444"}},
		{"kotak sent", "Sent Rs.75.00 from Kotak Bank AC X3344 to chaiwala@ybl on 13-11-25.UPI Ref 531744445555. Not you, https://kotak.com/KBANKT/Fraud",
			bankSMS{Direction: "debit", Amount: 7500, Last4: "3344", Bank: "Kotak Bank", Payee: "chaiwala@ybl", Merchant: "chaiwala@ybl", Ref: "531744445555"}},
		{"kotak received", "Received Rs.2000.00 in your Kotak Bank AC X3344 from priya@oksbi on 13-11-25.UPI Ref:531766667777.",
			bankSMS{Direction: "credit", Amount: 200000, Last4: "3344", Bank: "Kotak Bank", Payee: "priya@oksbi", Merchant: "priya@oksbi", Ref: "531766667777"}},
		{"card spend", "Rs.1,249.00 spent on HDFC Bank Credit Card xx6789 at AMAZON on 2025-11-13:10:22:01.Avl bal: Rs.48,751.00.Not you? Call 18002586161",
			bankSMS{Direction: "debit", Amount: 124900, Last4: "6789", Bank: "HDFC Bank", Merchant: "Amazon"}},
		{"federal debit", "Rs 300.00 debited from your A/c XX5566 using UPI on 13-11-2025 to VPA fuel.station@hdfcbank. Avl Bal Rs 12,000.50 -Federal Bank",
			bankSMS{Direction: "debit", Amount: 30000, Last4: "5566", Bank: "Federal Bank", Payee: "fuel.station@hdfcbank", Merchant: "fuel.station@hdfcbank"}},
		{"balance first", "Avl Bal Rs 10,000.00. Rs 450 debited from A/c XX1111 to ZOMATO on 13-11-25 Ref 531788889999",
			bankSMS{Direction: "debit", Amount: 45000, Last4: "1111", Merchant: "Zomato", Ref: "531788889999"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := parseBankSMS(c.text)
			if !ok {
				t.Fatalf("not recognised")
			}
			if got != c.want {
				t.Errorf("\n got %+v\nwant %+v", got, c.want)
			}
		})
	}
}

func TestParseBankSMSIgnoresNoise(t *testing.T) {
	for _, text := range []string{
		"123456 is your OTP for txn of Rs 500.00 at AMAZON on HDFC Bank card xx6789. Valid for 10 mins.",
		"Rs 199 will be debited from your A/c XX1234 on 15-11-25 for Netflix mandate.",
		"rahul@okaxis has requested money from you. Amount Rs.500. On approving, money will be debited.",
		"Your txn of Rs 500 failed. Any amount debited will be refunded in 3 days.",
		"Your HDFC Bank Credit Card bill of Rs 4,500 is due on 20-11-25. Min amt due Rs 450.",
		"hey I sent you the photos",
		"Paid the electricity guy, will tell you later",
		"Get pre-approved personal loan of Rs 5,00,000! Apply now",
	} {
		if m, ok := parseBankSMS(text); ok {
			t.Errorf("read %q as %+v", text, m)
		}
	}
}
