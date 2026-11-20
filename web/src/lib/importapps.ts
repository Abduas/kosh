// The money apps people move to Kosh from, with how to get each one's file
// out. Import (screens/Import.tsx) and onboarding show them; the server
// recognises each app's file by its columns (import_csv.go), so these steps
// are only about getting the file. Menus move between app versions, so each
// app's steps end with what to look for if a step has moved.

export type ImportApp = {
  id: string
  name: string
  color: string
  letter: string
  /** Where it runs, shown under the name. */
  where: string
  steps: string[]
  /** Something worth knowing before exporting, like a paid plan. */
  note?: string
  /** The file keeps accounts, so onboarding needn't ask for them. */
  hasAccounts: boolean
}

export const IMPORT_APPS: ImportApp[] = [
  {
    id: 'dime',
    name: 'Dime',
    color: '#111111',
    letter: 'D',
    where: 'iPhone',
    hasAccounts: false,
    steps: ['Open Dime and go to Settings.', 'Tap Export data and choose CSV.', 'Tap Save to Files.'],
    note: 'Dime doesn’t keep accounts, so you’ll pick which account they go in.',
  },
  {
    id: 'cashew',
    name: 'Cashew',
    color: '#5B4BDB',
    letter: 'C',
    where: 'iPhone, Android, web',
    hasAccounts: true,
    steps: ['Open Cashew and go to Settings & Customization.', 'Tap Export CSV file, then All time.', 'Save the file to Files.'],
  },
  {
    id: 'moneymanager',
    name: 'Money Manager',
    color: '#E5484D',
    letter: 'M',
    where: 'iPhone, Android',
    hasAccounts: true,
    steps: ['Open Money Manager and tap More (or Settings).', 'Tap Backup, then Export to Excel.', 'Save the Excel file to Files. Kosh reads it as it is.'],
  },
  {
    id: 'moneylover',
    name: 'Money Lover',
    color: '#2DB84C',
    letter: 'L',
    where: 'iPhone, Android, web',
    hasAccounts: true,
    steps: ['Open Money Lover and go to Settings (or Tools).', 'Tap Export to CSV, pick All wallets and the whole period.', 'Save the file to Files.'],
  },
  {
    id: 'wallet',
    name: 'Wallet',
    color: '#2F80ED',
    letter: 'W',
    where: 'web',
    hasAccounts: true,
    steps: ['On a computer, sign in at web.budgetbakers.com.', 'Open Records, choose the whole period, then Export → CSV.', 'Send the file to your phone, or import it here from the computer.'],
    note: 'Exporting needs Wallet’s paid plan.',
  },
  {
    id: 'spendee',
    name: 'Spendee',
    color: '#13C18D',
    letter: 'S',
    where: 'web',
    hasAccounts: true,
    steps: ['On a computer, sign in at app.spendee.com.', 'Open a wallet, then Export → CSV. Do this for each wallet.', 'Import each file here.'],
    note: 'Exporting needs Spendee’s paid plan.',
  },
  {
    id: 'monefy',
    name: 'Monefy',
    color: '#00B0B9',
    letter: 'M',
    where: 'iPhone, Android',
    hasAccounts: true,
    steps: ['Open Monefy and tap the menu (≡).', 'Tap Settings, then Export to file (CSV).', 'Save the file to Files.'],
  },
  {
    id: 'onemoney',
    name: '1Money',
    color: '#F2994A',
    letter: '1',
    where: 'iPhone, Android',
    hasAccounts: true,
    steps: ['Open 1Money and go to Settings.', 'Tap Export data, then CSV.', 'Save the file to Files.'],
  },
  {
    id: 'bluecoins',
    name: 'Bluecoins',
    color: '#1E64C8',
    letter: 'B',
    where: 'Android',
    hasAccounts: true,
    steps: ['Open Bluecoins and go to Settings → Data.', 'Tap Export to Excel (CSV) and pick all transactions.', 'Send the file to yourself, then choose it here.'],
  },
  {
    id: 'moneypro',
    name: 'Money Pro',
    color: '#27AE60',
    letter: 'P',
    where: 'iPhone, Mac',
    hasAccounts: true,
    steps: ['Open Money Pro and go to Settings.', 'Tap Export, choose Transactions and CSV.', 'Save the file to Files.'],
  },
  {
    id: 'ynab',
    name: 'YNAB',
    color: '#3B5EDA',
    letter: 'Y',
    where: 'web',
    hasAccounts: true,
    steps: ['On ynab.com, open your plan’s menu (its name, top left).', 'Click Export plan data. You get a zip file.', 'Choose the zip here. No need to unzip it.'],
  },
  {
    id: 'ivy',
    name: 'Ivy Wallet',
    color: '#6C3FD9',
    letter: 'I',
    where: 'Android',
    hasAccounts: true,
    steps: ['Open Ivy Wallet and go to Settings.', 'Tap Export to CSV.', 'Send the file to yourself, then choose it here.'],
  },
  {
    id: 'toshl',
    name: 'Toshl',
    color: '#F4B400',
    letter: 'T',
    where: 'web',
    hasAccounts: true,
    steps: ['On toshl.com, open Export.', 'Choose CSV and the whole period.', 'Choose the file here.'],
  },
  {
    id: 'goodbudget',
    name: 'Goodbudget',
    color: '#2E9C6A',
    letter: 'G',
    where: 'web',
    hasAccounts: true,
    steps: ['On goodbudget.com, open Accounts.', 'Click Export history, and choose CSV.', 'Choose the file here. Envelopes become categories.'],
  },
]

/** Not an app: a bank's statement, or any other file. */
export const OTHER_SOURCES: ImportApp[] = [
  {
    id: 'bank',
    name: 'Bank statement',
    color: '#64748B',
    letter: '🏦',
    where: 'Any Indian bank',
    hasAccounts: false,
    steps: ['In net banking or your bank’s app, open Statements.', 'Pick the period and download it as Excel or CSV. PDF won’t work.', 'Choose the file here, then pick the account it’s for.'],
  },
  {
    id: 'other',
    name: 'Another app or sheet',
    color: '#94A3B8',
    letter: '…',
    where: 'Any CSV or Excel file',
    hasAccounts: false,
    steps: [
      'In the app’s settings, look for Export or Backup and choose CSV or Excel.',
      'A spreadsheet works too: one row per transaction, with at least a date and an amount column.',
      'Choose the file here.',
    ],
  },
]

export const findImportApp = (id: string | null | undefined) => [...IMPORT_APPS, ...OTHER_SOURCES].find((a) => a.id === id)

export const IMPORT_ACCEPT =
  '.csv,.tsv,.txt,.xlsx,.xls,.xlsm,.ods,.numbers,.zip,text/csv,text/plain,text/tab-separated-values,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/zip'
