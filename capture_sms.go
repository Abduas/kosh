package main

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// bankSMS is what Kosh reads out of a bank or UPI message.
type bankSMS struct {
	Direction string `json:"direction"` // "debit": money left an account; "credit": money arrived
	Amount    int64  `json:"amount"`    // paise
	Last4     string `json:"last4"`     // the account or card's last digits, 3 or 4 of them
	Bank      string `json:"bank"`
	Payee     string `json:"payee"`    // a UPI ID, when the message has one
	Merchant  string `json:"merchant"` // who, as the message names them
	Ref       string `json:"ref"`      // UPI reference / RRN, the same in every message about one payment
}

var (
	smsSpace = regexp.MustCompile(`\s+`)

	// Messages that mention money but aren't money that moved: OTPs, reminders,
	// collect requests, autopay notices, failures, bills and offers.
	smsNoise = regexp.MustCompile(`(?i)\b(otp|one[ -]time password|verification code|will be (?:auto[ -]?)?debited|will be credited|scheduled|has requested|requested (?:you|money|rs|inr)|collect request|payment request|failed|declined|unsuccessful|could not be|is due|due (?:on|date|by)|min(?:imum)? (?:amt|amount)|total (?:amt|amount) due|bill (?:of|for) rs|pre-?approved|eligible for|offer|cashback of up to)\b`)

	smsDebit  = regexp.MustCompile(`(?i)\b(debited|debit alert|spent|sent|paid|withdrawn|withdrawal|used for|purchase of|txn of|transaction of|dr\.?)\b`)
	smsCredit = regexp.MustCompile(`(?i)\b(credited|credit alert|received|deposited|refund(?:ed)?|reversed|cr\.?)\b`)

	// "debited by 500.0" (SBI writes no currency), checked first.
	smsKeywordAmount = regexp.MustCompile(`(?i)\b(?:debited|credited)\s+(?:by|with|for)\s+(?:(?:rs\.?|inr|₹)\s*)?([0-9][0-9,]*(?:\.[0-9]{1,2})?)`)
	smsAmount        = regexp.MustCompile(`(?i)(?:rs\.?|inr|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)`)
	// An amount right after one of these is a balance or limit, not the payment.
	smsBalance = regexp.MustCompile(`(?i)(bal(?:ance)?|limit|avl|available|outstanding)[^0-9]{0,18}$`)

	smsLast4 = regexp.MustCompile(`(?i)\b(?:a/c|ac|acct|account|card|a/c no|acc)\b\.?\s*(?:no\.?|number|ending(?: with| in)?|ends with)?\s*[:\-]?\s*[x*•.\s]*([0-9]{3,6})\b`)
	smsVPA   = regexp.MustCompile(`(?i)([a-z0-9][a-z0-9._\-]{1,}@[a-z][a-z0-9]{1,})(\.[a-z]{2,})?`)

	smsRef = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\bupi/p2[am]/([0-9]{6,})/`),
		regexp.MustCompile(`(?i)\b(?:upi\s*)?(?:ref(?:erence)?|rrn|utr|txn\s*id|transaction\s*id)\s*(?:no\.?|number|id)?\s*[:.\-#]?\s*([0-9]{6,})`),
		regexp.MustCompile(`(?i)\brefno\s*[:.\-#]?\s*([0-9]{6,})`),
		regexp.MustCompile(`(?i)\bupi\s*[:.\-#(]?\s*([0-9]{9,})`),
	}

	// Who the money went to or came from. Each stops at the next part of the message.
	smsStop      = `(?:\s+on\b|\s+ref\b|\s+refno\b|\s+upi\b|\s+via\b|\s+using\b|\s+avl\b|\s+not you|\s+if not|\s+thru\b|\s+through\b|\s+at\b|\s+info\b|\.(?:\s|$)|[,;(]|\s*-\s*[a-z]+$|$)`
	smsName      = `([a-z0-9@&'_\- ][a-z0-9@&'._\- ]{1,59}?)`
	smsMerchants = map[string][]*regexp.Regexp{
		"debit": {
			regexp.MustCompile(`(?i)\bupi/p2[am]/[0-9]+/([^/]{2,60}?)(?:/|\s+not you|\s+if not|\s+avl\b|\.(?:\s|$)|$)`),
			regexp.MustCompile(`(?i);\s*` + smsName + `\s+credited\b`),
			regexp.MustCompile(`(?i)\btrf to\s+` + smsName + smsStop),
			regexp.MustCompile(`(?i)\b(?:paid|sent|spent)?\s*(?:to|towards)\s+(?:vpa\s+)?` + smsName + smsStop),
			regexp.MustCompile(`(?i)\bat\s+` + smsName + smsStop),
			regexp.MustCompile(`(?i)\bon\s+([a-z][a-z0-9&'._\- ]{1,59}?)(?:\.|\s+avl\b|\s+to\b|$)`),
		},
		"credit": {
			regexp.MustCompile(`(?i)\bupi/p2[am]/[0-9]+/([^/]{2,60}?)(?:/|\s+not you|\s+if not|\s+avl\b|\.(?:\s|$)|$)`),
			regexp.MustCompile(`(?i)\btransfer from\s+` + smsName + smsStop),
			regexp.MustCompile(`(?i)\bfrom\s+(?:vpa\s+)?` + smsName + smsStop),
			regexp.MustCompile(`(?i)\bby\s+` + smsName + smsStop),
		},
	}

	// Banks by the names their messages use. Longer, more specific names first.
	smsBanks = []struct{ name, pattern string }{
		{"Paytm Payments Bank", `paytm payments bank|ppbl`},
		{"Airtel Payments Bank", `airtel payments bank`},
		{"India Post Payments Bank", `ippb|india post payments`},
		{"State Bank of India", `\bsbi\b|state bank`},
		{"HDFC Bank", `\bhdfc`},
		{"ICICI Bank", `\bicici`},
		{"Axis Bank", `\baxis`},
		{"Kotak Bank", `\bkotak`},
		{"IDFC First Bank", `\bidfc`},
		{"IndusInd Bank", `\bindusind`},
		{"Yes Bank", `\byes bank`},
		{"Federal Bank", `\bfederal bank|\bfedbnk|\bfederal\b`},
		{"South Indian Bank", `south indian bank|\bsib\b`},
		{"Kerala Bank", `kerala bank|kerala gramin`},
		{"CSB Bank", `\bcsb\b`},
		{"Dhanlaxmi Bank", `dhanlaxmi`},
		{"Punjab National Bank", `\bpnb\b|punjab national`},
		{"Bank of Baroda", `bank of baroda|\bbob\b`},
		{"Canara Bank", `\bcanara`},
		{"Union Bank", `union bank`},
		{"Bank of India", `bank of india|\bboi\b`},
		{"Indian Overseas Bank", `indian overseas|\biob\b`},
		{"Indian Bank", `indian bank`},
		{"Central Bank", `central bank`},
		{"AU Bank", `\bau small|\bau bank`},
		{"RBL Bank", `\brbl\b`},
		{"Jupiter", `\bjupiter\b`},
		{"Fi", `\bfi money\b`},
		{"Amazon Pay", `amazon pay`},
		{"Paytm", `\bpaytm\b`},
	}
	smsBankRes = func() []*regexp.Regexp {
		out := make([]*regexp.Regexp, len(smsBanks))
		for i, b := range smsBanks {
			out[i] = regexp.MustCompile(`(?i)` + b.pattern)
		}
		return out
	}()
)

// parseBankSMS reads a bank or UPI message. ok is false for anything that
// isn't money that moved: a chat, an OTP, a reminder, a request or an offer.
func parseBankSMS(raw string) (m bankSMS, ok bool) {
	text := strings.TrimSpace(smsSpace.ReplaceAllString(raw, " "))
	if text == "" || len(text) > 2000 || smsNoise.MatchString(text) {
		return m, false
	}

	// Direction: whichever word comes first. "A/c debited ...; NAME credited"
	// is a payment out. "credit card" doesn't count as money in.
	scan := strings.NewReplacer("credit card", "card", "Credit Card", "card", "CREDIT CARD", "card", "Credit card", "card").Replace(text)
	d, c := smsDebit.FindStringIndex(scan), smsCredit.FindStringIndex(scan)
	switch {
	case d != nil && (c == nil || d[0] < c[0]):
		m.Direction = "debit"
	case c != nil:
		m.Direction = "credit"
	default:
		return m, false
	}

	if m.Amount = smsFindAmount(text); m.Amount <= 0 || m.Amount > maxAmount {
		return m, false
	}

	if sub := smsLast4.FindStringSubmatch(text); sub != nil {
		n := sub[1]
		if len(n) > 4 {
			n = n[len(n)-4:]
		}
		m.Last4 = n
	}
	// Bank names inside UPI IDs (shop@hdfcbank) say nothing about your bank.
	noIDs := smsVPA.ReplaceAllString(text, " ")
	for i, re := range smsBankRes {
		if re.MatchString(noIDs) {
			m.Bank = smsBanks[i].name
			break
		}
	}
	for _, sub := range smsVPA.FindAllStringSubmatch(text, -1) {
		if sub[2] == "" { // name@bank, not an email address
			m.Payee = strings.ToLower(sub[1])
			break
		}
	}
	for _, re := range smsRef {
		if sub := re.FindStringSubmatch(text); sub != nil {
			m.Ref = sub[1]
			break
		}
	}
	m.Merchant = smsFindMerchant(text, m.Direction)
	if m.Merchant == "" && m.Payee != "" {
		m.Merchant = m.Payee
	}
	return m, true
}

func smsFindAmount(text string) int64 {
	if sub := smsKeywordAmount.FindStringSubmatch(text); sub != nil {
		return smsRupees(sub[1])
	}
	for _, loc := range smsAmount.FindAllStringSubmatchIndex(text, -1) {
		if smsBalance.MatchString(text[max(0, loc[0]-30):loc[0]]) {
			continue
		}
		return smsRupees(text[loc[2]:loc[3]])
	}
	return 0
}

func smsRupees(s string) int64 {
	f, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", ""), 64)
	if err != nil || f <= 0 {
		return 0
	}
	return int64(math.Round(f * 100))
}

// Words that, at the start of a name, mean the pattern caught the wrong thing.
var smsNotName = regexp.MustCompile(`(?i)^(your|you|a/c|ac|acct|account|card|the|bank|rs|inr|upi|ref|vpa|mobile|beneficiary|linked|on|in|for|by|of|dear|customer|info|avl|bal)\b|^[0-9 ]+$|^x+[0-9]+`)

func smsFindMerchant(text, direction string) string {
	for _, re := range smsMerchants[direction] {
		for _, sub := range re.FindAllStringSubmatch(text, -1) {
			name := strings.Trim(strings.TrimSpace(sub[1]), ".-_ ")
			if len(name) < 2 || smsNotName.MatchString(name) {
				continue
			}
			if smsStartsWithBank(name) { // "credited to HDFC Bank A/c": your own account
				continue
			}
			if strings.Contains(name, "@") {
				return strings.ToLower(name)
			}
			return titleCase(name)
		}
	}
	return ""
}

func smsStartsWithBank(name string) bool {
	for _, re := range smsBankRes {
		if loc := re.FindStringIndex(name); loc != nil && loc[0] == 0 {
			return true
		}
	}
	return false
}

// titleCase turns "SWIGGY LIMITED" into "Swiggy Limited", leaving mixed case alone.
func titleCase(s string) string {
	if s != strings.ToUpper(s) && s != strings.ToLower(s) {
		return s
	}
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}
