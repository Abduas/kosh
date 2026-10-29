// Suggests an emoji for a new category from its name, so adding one is just
// typing a word. The first matching keyword wins.

const table: [RegExp, string][] = [
  [/coffee|cafe|caf[eé]|tea|chai/, '☕'],
  [/food|dining|restaurant|lunch|dinner|breakfast|meal|swiggy|zomato/, '🍜'],
  [/snack|sweet|dessert|bakery|cake/, '🍰'],
  [/grocer|vegetable|fruit|kirana|supermarket/, '🛒'],
  [/drink|bar|beer|alcohol|party/, '🍻'],
  [/fuel|petrol|diesel|gas station|cng/, '⛽'],
  [/car|vehicle|service|parking|toll/, '🚗'],
  [/bike|scooter/, '🛵'],
  [/transport|cab|taxi|uber|ola|auto|metro|bus|commute/, '🚕'],
  [/train|rail/, '🚆'],
  [/flight|travel|trip|holiday|vacation|hotel/, '✈️'],
  [/rent|house|home|maintenance|society/, '🏠'],
  [/electric|power|bill|utility|water/, '💡'],
  [/internet|wifi|broadband/, '🛜'],
  [/phone|mobile|recharge/, '📱'],
  [/subscription|netflix|spotify|prime|ott/, '📺'],
  [/movie|cinema|entertain|game|fun/, '🎬'],
  [/music|concert/, '🎵'],
  [/gym|fitness|sport|yoga|workout/, '🏋️'],
  [/health|medical|medicine|doctor|pharma|hospital/, '💊'],
  [/insurance/, '🛡️'],
  [/shop|cloth|fashion|amazon|flipkart|myntra/, '🛍️'],
  [/gadget|electronic|laptop|computer/, '💻'],
  [/book|education|course|school|college|fees|tuition|study/, '📚'],
  [/kid|child|baby|toy/, '🧸'],
  [/pet|dog|cat/, '🐶'],
  [/gift|present|wedding|shagun/, '🎁'],
  [/charity|donation|zakat|sadaqah|temple|mosque|church/, '🤲'],
  [/beauty|salon|haircut|grooming|spa|personal/, '💇'],
  [/family|parent|mom|dad/, '👨‍👩‍👧'],
  [/loan|emi|debt|credit/, '🏦'],
  [/invest|stock|mutual|sip|crypto|gold/, '📈'],
  [/saving/, '🐷'],
  [/tax/, '🧾'],
  [/salary|pay|wage|income/, '💼'],
  [/freelance|client|project|work|business/, '💻'],
  [/interest|dividend/, '📈'],
  [/refund|cashback/, '↩️'],
]

export function suggestEmoji(name: string): string | null {
  const n = name.toLowerCase().trim()
  if (!n) return null
  for (const [re, emoji] of table) if (re.test(n)) return emoji
  return null
}
