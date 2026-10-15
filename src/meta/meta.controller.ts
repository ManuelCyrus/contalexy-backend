import { Controller, Get, Headers } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { resolveLanguage, SUPPORTED_LANGUAGES } from '../common/i18n/messages';
import { COUNTRIES, CURRENCIES } from './countries.data';

const LANGUAGE_NAMES: Record<string, string> = { pt: 'Português', en: 'English', fr: 'Français', de: 'Deutsch' };

function displayNames(lang: string, type: 'region' | 'currency') {
  try {
    return new Intl.DisplayNames([lang, 'en'], { type });
  } catch {
    return null;
  }
}

function flag(code: string) {
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function currencyInfo(code: string, lang: string) {
  try {
    const formatter = new Intl.NumberFormat(lang, { style: 'currency', currency: code });
    const symbol = formatter.formatToParts(1).find((p) => p.type === 'currency')?.value ?? code;
    return { symbol, decimals: formatter.resolvedOptions().maximumFractionDigits ?? 2 };
  } catch {
    return { symbol: code, decimals: 2 };
  }
}

/// Listas para o registo e para as definições (públicas).
@Controller('meta')
export class MetaController {
  @Public()
  @Get('countries')
  countries(@Headers('accept-language') acceptLanguage?: string) {
    const lang = resolveLanguage(acceptLanguage);
    const names = displayNames(lang, 'region');
    return COUNTRIES.map((c) => ({
      code: c.code,
      name: names?.of(c.code) ?? c.code,
      flag: flag(c.code),
      currency: c.currency,
      language: c.language,
      openBanking: c.openBanking ?? false,
    })).sort((a, b) => a.name.localeCompare(b.name, lang));
  }

  @Public()
  @Get('currencies')
  currencies(@Headers('accept-language') acceptLanguage?: string) {
    const lang = resolveLanguage(acceptLanguage);
    const names = displayNames(lang, 'currency');
    return CURRENCIES.map((code) => ({ code, name: names?.of(code) ?? code, ...currencyInfo(code, lang) }));
  }

  @Public()
  @Get('languages')
  languages() {
    return SUPPORTED_LANGUAGES.map((code) => ({ code, name: LANGUAGE_NAMES[code] ?? code }));
  }
}
