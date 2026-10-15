/// Países disponíveis no registo, com a moeda por defeito. Os nomes saem
/// traduzidos (Intl.DisplayNames) no idioma de quem pede.
/// `openBanking` fica preparado para o futuro (ligação a bancos).
export interface CountryInfo {
  code: string;
  currency: string;
  /// Idioma mais provável (só uma sugestão — a app usa o do telemóvel)
  language: string;
  /// Fuso horário principal (quando a app não manda o do telemóvel)
  timezone: string;
  openBanking?: boolean;
}

export const COUNTRIES: CountryInfo[] = [
  { code: 'PT', currency: 'EUR', language: 'pt', timezone: 'Europe/Lisbon' },
  { code: 'BR', currency: 'BRL', language: 'pt', timezone: 'America/Sao_Paulo' },
  { code: 'AO', currency: 'AOA', language: 'pt', timezone: 'Africa/Luanda' },
  { code: 'MZ', currency: 'MZN', language: 'pt', timezone: 'Africa/Maputo' },
  { code: 'CV', currency: 'CVE', language: 'pt', timezone: 'Atlantic/Cape_Verde' },
  { code: 'GW', currency: 'XOF', language: 'pt', timezone: 'Africa/Bissau' },
  { code: 'ST', currency: 'STN', language: 'pt', timezone: 'Africa/Sao_Tome' },
  { code: 'TL', currency: 'USD', language: 'pt', timezone: 'Asia/Dili' },
  { code: 'FR', currency: 'EUR', language: 'fr', timezone: 'Europe/Paris' },
  { code: 'DE', currency: 'EUR', language: 'de', timezone: 'Europe/Berlin' },
  { code: 'AT', currency: 'EUR', language: 'de', timezone: 'Europe/Vienna' },
  { code: 'CH', currency: 'CHF', language: 'de', timezone: 'Europe/Zurich' },
  { code: 'BE', currency: 'EUR', language: 'fr', timezone: 'Europe/Brussels' },
  { code: 'LU', currency: 'EUR', language: 'fr', timezone: 'Europe/Luxembourg' },
  { code: 'NL', currency: 'EUR', language: 'en', timezone: 'Europe/Amsterdam' },
  { code: 'ES', currency: 'EUR', language: 'en', timezone: 'Europe/Madrid' },
  { code: 'IT', currency: 'EUR', language: 'en', timezone: 'Europe/Rome' },
  { code: 'IE', currency: 'EUR', language: 'en', timezone: 'Europe/Dublin' },
  { code: 'GB', currency: 'GBP', language: 'en', timezone: 'Europe/London' },
  { code: 'US', currency: 'USD', language: 'en', timezone: 'America/New_York' },
  { code: 'CA', currency: 'CAD', language: 'en', timezone: 'America/Toronto' },
  { code: 'AU', currency: 'AUD', language: 'en', timezone: 'Australia/Sydney' },
  { code: 'NZ', currency: 'NZD', language: 'en', timezone: 'Pacific/Auckland' },
  { code: 'DK', currency: 'DKK', language: 'en', timezone: 'Europe/Copenhagen' },
  { code: 'SE', currency: 'SEK', language: 'en', timezone: 'Europe/Stockholm' },
  { code: 'NO', currency: 'NOK', language: 'en', timezone: 'Europe/Oslo' },
  { code: 'FI', currency: 'EUR', language: 'en', timezone: 'Europe/Helsinki' },
  { code: 'IS', currency: 'ISK', language: 'en', timezone: 'Atlantic/Reykjavik' },
  { code: 'PL', currency: 'PLN', language: 'en', timezone: 'Europe/Warsaw' },
  { code: 'CZ', currency: 'CZK', language: 'en', timezone: 'Europe/Prague' },
  { code: 'SK', currency: 'EUR', language: 'en', timezone: 'Europe/Bratislava' },
  { code: 'HU', currency: 'HUF', language: 'en', timezone: 'Europe/Budapest' },
  { code: 'RO', currency: 'RON', language: 'en', timezone: 'Europe/Bucharest' },
  { code: 'BG', currency: 'BGN', language: 'en', timezone: 'Europe/Sofia' },
  { code: 'GR', currency: 'EUR', language: 'en', timezone: 'Europe/Athens' },
  { code: 'CY', currency: 'EUR', language: 'en', timezone: 'Asia/Nicosia' },
  { code: 'MT', currency: 'EUR', language: 'en', timezone: 'Europe/Malta' },
  { code: 'HR', currency: 'EUR', language: 'en', timezone: 'Europe/Zagreb' },
  { code: 'SI', currency: 'EUR', language: 'en', timezone: 'Europe/Ljubljana' },
  { code: 'EE', currency: 'EUR', language: 'en', timezone: 'Europe/Tallinn' },
  { code: 'LV', currency: 'EUR', language: 'en', timezone: 'Europe/Riga' },
  { code: 'LT', currency: 'EUR', language: 'en', timezone: 'Europe/Vilnius' },
  { code: 'MC', currency: 'EUR', language: 'fr', timezone: 'Europe/Monaco' },
  { code: 'LI', currency: 'CHF', language: 'de', timezone: 'Europe/Vaduz' },
  { code: 'AD', currency: 'EUR', language: 'en', timezone: 'Europe/Andorra' },
  { code: 'TR', currency: 'TRY', language: 'en', timezone: 'Europe/Istanbul' },
  { code: 'UA', currency: 'UAH', language: 'en', timezone: 'Europe/Kyiv' },
  { code: 'RS', currency: 'RSD', language: 'en', timezone: 'Europe/Belgrade' },
  { code: 'MX', currency: 'MXN', language: 'en', timezone: 'America/Mexico_City' },
  { code: 'AR', currency: 'ARS', language: 'en', timezone: 'America/Argentina/Buenos_Aires' },
  { code: 'CL', currency: 'CLP', language: 'en', timezone: 'America/Santiago' },
  { code: 'CO', currency: 'COP', language: 'en', timezone: 'America/Bogota' },
  { code: 'PE', currency: 'PEN', language: 'en', timezone: 'America/Lima' },
  { code: 'UY', currency: 'UYU', language: 'en', timezone: 'America/Montevideo' },
  { code: 'PY', currency: 'PYG', language: 'en', timezone: 'America/Asuncion' },
  { code: 'BO', currency: 'BOB', language: 'en', timezone: 'America/La_Paz' },
  { code: 'VE', currency: 'USD', language: 'en', timezone: 'America/Caracas' },
  { code: 'EC', currency: 'USD', language: 'en', timezone: 'America/Guayaquil' },
  { code: 'DO', currency: 'DOP', language: 'en', timezone: 'America/Santo_Domingo' },
  { code: 'CR', currency: 'CRC', language: 'en', timezone: 'America/Costa_Rica' },
  { code: 'PA', currency: 'USD', language: 'en', timezone: 'America/Panama' },
  { code: 'MA', currency: 'MAD', language: 'fr', timezone: 'Africa/Casablanca' },
  { code: 'DZ', currency: 'DZD', language: 'fr', timezone: 'Africa/Algiers' },
  { code: 'TN', currency: 'TND', language: 'fr', timezone: 'Africa/Tunis' },
  { code: 'SN', currency: 'XOF', language: 'fr', timezone: 'Africa/Dakar' },
  { code: 'CI', currency: 'XOF', language: 'fr', timezone: 'Africa/Abidjan' },
  { code: 'CM', currency: 'XAF', language: 'fr', timezone: 'Africa/Douala' },
  { code: 'CD', currency: 'CDF', language: 'fr', timezone: 'Africa/Kinshasa' },
  { code: 'NG', currency: 'NGN', language: 'en', timezone: 'Africa/Lagos' },
  { code: 'GH', currency: 'GHS', language: 'en', timezone: 'Africa/Accra' },
  { code: 'KE', currency: 'KES', language: 'en', timezone: 'Africa/Nairobi' },
  { code: 'ZA', currency: 'ZAR', language: 'en', timezone: 'Africa/Johannesburg' },
  { code: 'EG', currency: 'EGP', language: 'en', timezone: 'Africa/Cairo' },
  { code: 'AE', currency: 'AED', language: 'en', timezone: 'Asia/Dubai' },
  { code: 'SA', currency: 'SAR', language: 'en', timezone: 'Asia/Riyadh' },
  { code: 'QA', currency: 'QAR', language: 'en', timezone: 'Asia/Qatar' },
  { code: 'IL', currency: 'ILS', language: 'en', timezone: 'Asia/Jerusalem' },
  { code: 'IN', currency: 'INR', language: 'en', timezone: 'Asia/Kolkata' },
  { code: 'PK', currency: 'PKR', language: 'en', timezone: 'Asia/Karachi' },
  { code: 'CN', currency: 'CNY', language: 'en', timezone: 'Asia/Shanghai' },
  { code: 'HK', currency: 'HKD', language: 'en', timezone: 'Asia/Hong_Kong' },
  { code: 'JP', currency: 'JPY', language: 'en', timezone: 'Asia/Tokyo' },
  { code: 'KR', currency: 'KRW', language: 'en', timezone: 'Asia/Seoul' },
  { code: 'SG', currency: 'SGD', language: 'en', timezone: 'Asia/Singapore' },
  { code: 'MY', currency: 'MYR', language: 'en', timezone: 'Asia/Kuala_Lumpur' },
  { code: 'TH', currency: 'THB', language: 'en', timezone: 'Asia/Bangkok' },
  { code: 'ID', currency: 'IDR', language: 'en', timezone: 'Asia/Jakarta' },
  { code: 'PH', currency: 'PHP', language: 'en', timezone: 'Asia/Manila' },
  { code: 'VN', currency: 'VND', language: 'en', timezone: 'Asia/Ho_Chi_Minh' },
  { code: 'MO', currency: 'MOP', language: 'pt', timezone: 'Asia/Macau' },
];

/// Moedas aceites (as dos países + as mais usadas).
export const CURRENCIES: string[] = Array.from(
  new Set([...COUNTRIES.map((c) => c.currency), 'EUR', 'USD', 'GBP', 'CHF', 'BRL', 'AOA', 'MZN', 'CVE', 'JPY', 'CNY', 'CAD', 'AUD']),
).sort();

export const isCountry = (code: string) => COUNTRIES.some((c) => c.code === code);
/// Fuso horário por omissão de um país (o principal).
export const countryTimezone = (code: string | null | undefined) => COUNTRIES.find((c) => c.code === code?.toUpperCase())?.timezone ?? null;

export const isCurrency = (code: string) => CURRENCIES.includes(code);
export const countryInfo = (code: string) => COUNTRIES.find((c) => c.code === code);
