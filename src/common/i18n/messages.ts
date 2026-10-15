/// Textos do servidor em todos os idiomas da app. Para juntar um idioma
/// novo: acrescenta-o a SUPPORTED_LANGUAGES e preenche as entradas — o
/// resto do código não muda. O que faltar cai para inglês.

export const SUPPORTED_LANGUAGES = ['pt', 'en', 'fr', 'de'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

type Dict = Record<string, Partial<Record<Language, string>>>;

/// "pt-PT,pt;q=0.9,en;q=0.8" → "pt". Desconhecido → inglês.
export function resolveLanguage(input?: string | null): Language {
  if (!input) return DEFAULT_LANGUAGE;
  for (const part of input.split(',')) {
    const code = part.split(';')[0].trim().toLowerCase().split(/[-_]/)[0];
    if ((SUPPORTED_LANGUAGES as readonly string[]).includes(code)) return code as Language;
  }
  return DEFAULT_LANGUAGE;
}

export function isSupportedLanguage(code: string): code is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(code);
}

function format(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => (params[key] === undefined || params[key] === null ? '' : String(params[key])));
}

function pick(dict: Dict, key: string, lang: Language, params?: Record<string, unknown>): string | null {
  const entry = dict[key];
  if (!entry) return null;
  const text = entry[lang] ?? entry[DEFAULT_LANGUAGE];
  return text ? format(text, params) : null;
}

// ------------------------------------------------------------------
// Erros (por código)
// ------------------------------------------------------------------

export const ERRORS: Dict = {
  SHARE_HELP_NOT_ALLOWED: { pt: 'Quem ajuda a gerir não pode fazer isto.', en: 'Helpers can’t do this.', fr: 'Cette action n’est pas possible quand tu aides à gérer.', de: 'Das geht beim Mitverwalten nicht.' },
  SHARE_HELP_OFF: { pt: 'Esta pessoa não te deixou ajudar a gerir.', en: 'This person hasn’t let you help manage their money.', fr: 'Cette personne ne t’a pas permis d’aider à gérer.', de: 'Diese Person hat dir das Mitverwalten nicht erlaubt.' },
  SHARE_HELP_SECTION: { pt: 'Esta pessoa não te deixou alterar esta parte.', en: 'This person hasn’t let you change this part.', fr: 'Cette personne ne t’a pas permis de modifier cette partie.', de: 'Diese Person hat dir nicht erlaubt, diesen Teil zu ändern.' },
  SHARE_HELP_NEEDS_ALL: { pt: 'Para alguém te ajudar a gerir, mostra todas as categorias.', en: 'To let someone help you manage, show all categories.', fr: 'Pour qu’une personne t’aide à gérer, montre toutes les catégories.', de: 'Damit dir jemand beim Verwalten hilft, zeige alle Kategorien.' },
  REMINDER_SENT_TODAY: { pt: 'Já mandaste um lembrete hoje. Tenta amanhã.', en: 'You already sent a reminder today. Try again tomorrow.', fr: 'Tu as déjà envoyé un rappel aujourd’hui. Réessaie demain.', de: 'Du hast heute schon eine Erinnerung geschickt. Versuch es morgen wieder.' },
  SPACE_NOTHING_OWED: { pt: 'Esta pessoa não te deve nada neste Space.', en: 'This person doesn’t owe you anything in this Space.', fr: 'Cette personne ne te doit rien dans ce Space.', de: 'Diese Person schuldet dir in diesem Space nichts.' },
  INTERNAL_ERROR: {
    pt: 'Algo correu mal. Tenta novamente.',
    en: 'Something went wrong. Please try again.',
    fr: 'Une erreur est survenue. Réessaie.',
    de: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
  },
  INVALID_REQUEST: {
    pt: 'O pedido não é válido.',
    en: 'The request is not valid.',
    fr: 'La requête n’est pas valide.',
    de: 'Die Anfrage ist ungültig.',
  },
  VALIDATION_ERROR: {
    pt: 'Há dados em falta ou inválidos.',
    en: 'Some data is missing or invalid.',
    fr: 'Certaines données sont manquantes ou invalides.',
    de: 'Einige Angaben fehlen oder sind ungültig.',
  },
  UNAUTHORIZED: {
    pt: 'Precisas de iniciar sessão.',
    en: 'You need to sign in.',
    fr: 'Tu dois te connecter.',
    de: 'Du musst dich anmelden.',
  },
  SESSION_EXPIRED: {
    pt: 'A sessão expirou. Inicia sessão novamente.',
    en: 'Your session has expired. Please sign in again.',
    fr: 'Ta session a expiré. Reconnecte-toi.',
    de: 'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.',
  },
  INVALID_CREDENTIALS: {
    pt: 'Email/username ou palavra-passe errados.',
    en: 'Wrong email/username or password.',
    fr: 'E-mail/nom d’utilisateur ou mot de passe incorrect.',
    de: 'E-Mail/Benutzername oder Passwort falsch.',
  },
  GOOGLE_NOT_CONFIGURED: {
    pt: 'Entrar com o Google ainda não está disponível.',
    en: 'Google sign-in is not available yet.',
    fr: 'La connexion avec Google n’est pas encore disponible.',
    de: 'Die Anmeldung mit Google ist noch nicht verfügbar.',
  },
  GOOGLE_TOKEN_INVALID: {
    pt: 'Não foi possível confirmar a tua conta Google. Tenta outra vez.',
    en: 'We couldn’t confirm your Google account. Please try again.',
    fr: 'Impossible de confirmer ton compte Google. Réessaie.',
    de: 'Dein Google-Konto konnte nicht bestätigt werden. Versuch es noch einmal.',
  },
  GOOGLE_EMAIL_NOT_VERIFIED: {
    pt: 'O email desta conta Google não está confirmado.',
    en: 'The email of this Google account is not verified.',
    fr: 'L’e-mail de ce compte Google n’est pas vérifié.',
    de: 'Die E-Mail dieses Google-Kontos ist nicht bestätigt.',
  },
  GOOGLE_CONFIRM_REQUIRED: {
    pt: 'Confirma com a tua conta Google para continuar.',
    en: 'Confirm with your Google account to continue.',
    fr: 'Confirme avec ton compte Google pour continuer.',
    de: 'Bestätige mit deinem Google-Konto, um fortzufahren.',
  },
  GOOGLE_ACCOUNT_MISMATCH: {
    pt: 'Essa não é a conta Google ligada a esta conta.',
    en: 'That is not the Google account linked to this account.',
    fr: 'Ce n’est pas le compte Google lié à ce compte.',
    de: 'Das ist nicht das mit diesem Konto verknüpfte Google-Konto.',
  },
  WRONG_PASSWORD: {
    pt: 'A palavra-passe atual está errada.',
    en: 'Your current password is wrong.',
    fr: 'Ton mot de passe actuel est incorrect.',
    de: 'Dein aktuelles Passwort ist falsch.',
  },
  EMAIL_TAKEN: {
    pt: 'Já existe uma conta com este email.',
    en: 'There is already an account with this email.',
    fr: 'Un compte existe déjà avec cet e-mail.',
    de: 'Mit dieser E-Mail gibt es bereits ein Konto.',
  },
  USERNAME_TAKEN: {
    pt: 'Este username já está a ser usado.',
    en: 'This username is already taken.',
    fr: 'Ce nom d’utilisateur est déjà pris.',
    de: 'Dieser Benutzername ist bereits vergeben.',
  },
  USERNAME_INVALID: {
    pt: 'O username só pode ter letras, números, "." e "_" (3 a 24).',
    en: 'Usernames can only have letters, numbers, "." and "_" (3 to 24).',
    fr: 'Le nom d’utilisateur ne peut contenir que des lettres, chiffres, « . » et « _ » (3 à 24).',
    de: 'Benutzernamen dürfen nur Buchstaben, Zahlen, „.“ und „_“ enthalten (3 bis 24).',
  },
  WEAK_PASSWORD: {
    pt: 'A palavra-passe precisa de pelo menos 8 caracteres, com letras e números.',
    en: 'Your password needs at least 8 characters, with letters and numbers.',
    fr: 'Le mot de passe doit contenir au moins 8 caractères, avec des lettres et des chiffres.',
    de: 'Das Passwort braucht mindestens 8 Zeichen mit Buchstaben und Zahlen.',
  },
  RESET_CODE_INVALID: {
    pt: 'O código não está certo ou já expirou.',
    en: 'The code is wrong or has expired.',
    fr: 'Le code est incorrect ou a expiré.',
    de: 'Der Code ist falsch oder abgelaufen.',
  },
  TOO_MANY_ATTEMPTS: {
    pt: 'Demasiadas tentativas. Pede um código novo.',
    en: 'Too many attempts. Request a new code.',
    fr: 'Trop de tentatives. Demande un nouveau code.',
    de: 'Zu viele Versuche. Fordere einen neuen Code an.',
  },
  TOO_MANY_REQUESTS: {
    pt: 'Demasiados pedidos. Espera um pouco.',
    en: 'Too many requests. Please wait a moment.',
    fr: 'Trop de requêtes. Patiente un instant.',
    de: 'Zu viele Anfragen. Bitte warte kurz.',
  },
  FORBIDDEN: {
    pt: 'Não tens permissão para isto.',
    en: 'You don’t have permission to do this.',
    fr: 'Tu n’as pas la permission de faire cela.',
    de: 'Dafür hast du keine Berechtigung.',
  },
  NOT_FOUND: {
    pt: 'Não encontrado.',
    en: 'Not found.',
    fr: 'Introuvable.',
    de: 'Nicht gefunden.',
  },
  ACCOUNT_NOT_FOUND: { pt: 'Conta não encontrada.', en: 'Account not found.', fr: 'Compte introuvable.', de: 'Konto nicht gefunden.' },
  CATEGORY_NOT_FOUND: { pt: 'Categoria não encontrada.', en: 'Category not found.', fr: 'Catégorie introuvable.', de: 'Kategorie nicht gefunden.' },
  TRANSACTION_NOT_FOUND: { pt: 'Movimento não encontrado.', en: 'Transaction not found.', fr: 'Opération introuvable.', de: 'Buchung nicht gefunden.' },
  RECURRING_NOT_FOUND: { pt: 'Pagamento recorrente não encontrado.', en: 'Recurring payment not found.', fr: 'Paiement récurrent introuvable.', de: 'Dauerauftrag nicht gefunden.' },
  BUDGET_NOT_FOUND: { pt: 'Orçamento não encontrado.', en: 'Budget not found.', fr: 'Budget introuvable.', de: 'Budget nicht gefunden.' },
  GOAL_NOT_FOUND: { pt: 'Objetivo não encontrado.', en: 'Goal not found.', fr: 'Objectif introuvable.', de: 'Ziel nicht gefunden.' },
  PLAN_NOT_FOUND: { pt: 'Plano não encontrado.', en: 'Plan not found.', fr: 'Plan introuvable.', de: 'Plan nicht gefunden.' },
  PLAN_ITEM_NOT_FOUND: { pt: 'Item não encontrado.', en: 'Item not found.', fr: 'Élément introuvable.', de: 'Eintrag nicht gefunden.' },
  SPACE_NOT_FOUND: { pt: 'Space não encontrado.', en: 'Space not found.', fr: 'Espace introuvable.', de: 'Space nicht gefunden.' },
  INVITATION_NOT_FOUND: { pt: 'Convite não encontrado.', en: 'Invitation not found.', fr: 'Invitation introuvable.', de: 'Einladung nicht gefunden.' },
  EXPENSE_NOT_FOUND: { pt: 'Despesa não encontrada.', en: 'Expense not found.', fr: 'Dépense introuvable.', de: 'Ausgabe nicht gefunden.' },
  SETTLEMENT_NOT_FOUND: { pt: 'Acerto não encontrado.', en: 'Settlement not found.', fr: 'Remboursement introuvable.', de: 'Ausgleich nicht gefunden.' },
  RULE_NOT_FOUND: { pt: 'Regra não encontrada.', en: 'Rule not found.', fr: 'Règle introuvable.', de: 'Regel nicht gefunden.' },
  FILTER_NOT_FOUND: { pt: 'Filtro não encontrado.', en: 'Filter not found.', fr: 'Filtre introuvable.', de: 'Filter nicht gefunden.' },
  FILE_NOT_FOUND: { pt: 'Ficheiro não encontrado.', en: 'File not found.', fr: 'Fichier introuvable.', de: 'Datei nicht gefunden.' },
  USER_NOT_FOUND: { pt: 'Não encontrámos essa pessoa.', en: 'We couldn’t find that person.', fr: 'Nous n’avons pas trouvé cette personne.', de: 'Wir konnten diese Person nicht finden.' },
  PRICE_NOT_FOUND: { pt: 'Preço não encontrado.', en: 'Price not found.', fr: 'Prix introuvable.', de: 'Preis nicht gefunden.' },
  NOTIFICATION_NOT_FOUND: { pt: 'Notificação não encontrada.', en: 'Notification not found.', fr: 'Notification introuvable.', de: 'Benachrichtigung nicht gefunden.' },
  GOAL_DEPOSIT_NOT_FOUND: { pt: 'Depósito planeado não encontrado.', en: 'Planned deposit not found.', fr: 'Dépôt prévu introuvable.', de: 'Geplante Einzahlung nicht gefunden.' },
  GOAL_DEPOSIT_CLOSED: { pt: 'Este depósito planeado já acabou.', en: 'This planned deposit has ended.', fr: 'Ce dépôt prévu est terminé.', de: 'Diese geplante Einzahlung ist beendet.' },
  GOAL_NOT_ACTIVE: { pt: 'Este objetivo já não está ativo.', en: 'This goal is no longer active.', fr: 'Cet objectif n’est plus actif.', de: 'Dieses Ziel ist nicht mehr aktiv.' },
  DEPOSIT_DATE_PAST: { pt: 'Escolhe hoje ou um dia que ainda aí vem.', en: 'Pick today or a day ahead.', fr: 'Choisis aujourd’hui ou un jour à venir.', de: 'Wähle heute oder einen kommenden Tag.' },
  SESSION_NOT_FOUND: {
    pt: 'Sessão não encontrada.',
    en: 'Session not found.',
    fr: 'Session introuvable.',
    de: 'Sitzung nicht gefunden.',
  },
  LOAN_LINK_SELF: {
    pt: 'Não podes ligar um empréstimo a ti mesmo.',
    en: 'You can’t link a loan to yourself.',
    fr: 'Tu ne peux pas lier un prêt à toi-même.',
    de: 'Du kannst ein Darlehen nicht mit dir selbst verknüpfen.',
  },
  LOAN_ALREADY_LINKED: {
    pt: 'Este empréstimo já está ligado a uma pessoa.',
    en: 'This loan is already linked to someone.',
    fr: 'Ce prêt est déjà lié à quelqu’un.',
    de: 'Dieses Darlehen ist bereits mit jemandem verknüpft.',
  },
  LOAN_NOT_LINKED: {
    pt: 'Este empréstimo não está ligado a ninguém.',
    en: 'This loan isn’t linked to anyone.',
    fr: 'Ce prêt n’est lié à personne.',
    de: 'Dieses Darlehen ist mit niemandem verknüpft.',
  },
  LOAN_REQUEST_CLOSED: {
    pt: 'Este pedido já foi respondido.',
    en: 'This request has already been answered.',
    fr: 'Cette demande a déjà reçu une réponse.',
    de: 'Diese Anfrage wurde bereits beantwortet.',
  },
  LOAN_OWNER_ONLY: {
    pt: 'Só quem criou o empréstimo pode fazer isto.',
    en: 'Only the person who created the loan can do this.',
    fr: 'Seule la personne qui a créé le prêt peut faire cela.',
    de: 'Das kann nur die Person tun, die das Darlehen angelegt hat.',
  },
  PLAN_OFFER_NOT_FOUND: {
    pt: 'Plano enviado não encontrado.',
    en: 'Shared plan not found.',
    fr: 'Plan envoyé introuvable.',
    de: 'Gesendeter Plan nicht gefunden.',
  },
  PLAN_OFFER_CLOSED: {
    pt: 'Este plano já foi respondido.',
    en: 'This plan has already been answered.',
    fr: 'Ce plan a déjà reçu une réponse.',
    de: 'Dieser Plan wurde bereits beantwortet.',
  },
  PLAN_OFFER_SELF: {
    pt: 'Não podes enviar um plano a ti mesmo.',
    en: 'You can’t send a plan to yourself.',
    fr: 'Tu ne peux pas t’envoyer un plan à toi-même.',
    de: 'Du kannst dir selbst keinen Plan senden.',
  },
  PLAN_OFFER_EMPTY: {
    pt: 'O plano não tem linhas para enviar.',
    en: 'The plan has no lines to send.',
    fr: 'Le plan n’a aucune ligne à envoyer.',
    de: 'Der Plan hat keine Zeilen zum Senden.',
  },
  PLAN_OFFER_LIMIT: {
    pt: 'Tens demasiados planos enviados à espera de resposta ({max}).',
    en: 'You have too many sent plans waiting for an answer ({max}).',
    fr: 'Tu as trop de plans envoyés en attente de réponse ({max}).',
    de: 'Du hast zu viele gesendete Pläne, die auf Antwort warten ({max}).',
  },
  OFFER_NOT_FOUND: {
    pt: 'Envio não encontrado.',
    en: 'Shared item not found.',
    fr: 'Envoi introuvable.',
    de: 'Sendung nicht gefunden.',
  },
  OFFER_CLOSED: {
    pt: 'Este envio já foi respondido.',
    en: 'This has already been answered.',
    fr: 'Cet envoi a déjà reçu une réponse.',
    de: 'Darauf wurde bereits geantwortet.',
  },
  OFFER_SELF: {
    pt: 'Não podes enviar isto a ti mesmo.',
    en: 'You can’t send this to yourself.',
    fr: 'Tu ne peux pas t’envoyer ceci à toi-même.',
    de: 'Das kannst du dir nicht selbst senden.',
  },
  OFFER_LIMIT: {
    pt: 'Tens demasiados envios à espera de resposta ({max}).',
    en: 'You have too many shared items waiting for an answer ({max}).',
    fr: 'Tu as trop d’envois en attente de réponse ({max}).',
    de: 'Du hast zu viele Sendungen, die auf Antwort warten ({max}).',
  },
  OFFER_NO_CATEGORY: {
    pt: 'Não tens nenhuma das categorias deste limite. Cria a categoria e aceita outra vez.',
    en: 'You don’t have any of this limit’s categories. Create the category and accept again.',
    fr: 'Tu n’as aucune des catégories de ce plafond. Crée la catégorie puis accepte à nouveau.',
    de: 'Du hast keine der Kategorien dieses Limits. Lege die Kategorie an und nimm erneut an.',
  },
  GOAL_STEP_NOT_FOUND: {
    pt: 'Objetivo específico não encontrado.',
    en: 'Step not found.',
    fr: 'Étape introuvable.',
    de: 'Schritt nicht gefunden.',
  },
  GOAL_STEPS_LIMIT: {
    pt: 'Um objetivo pode ter até {max} objetivos específicos.',
    en: 'A goal can have up to {max} steps.',
    fr: 'Un objectif peut avoir jusqu’à {max} étapes.',
    de: 'Ein Ziel kann bis zu {max} Schritte haben.',
  },
  GOAL_STEP_AFTER_END: {
    pt: 'A data deste objetivo específico fica depois do fim do objetivo.',
    en: 'This step’s date is after the goal’s end date.',
    fr: 'La date de cette étape est après la fin de l’objectif.',
    de: 'Das Datum dieses Schritts liegt nach dem Ende des Ziels.',
  },
  SHARE_SECTION_HIDDEN: {
    pt: 'Esta pessoa não partilha essa parte contigo.',
    en: 'This person doesn’t share that part with you.',
    fr: 'Cette personne ne partage pas cette partie avec toi.',
    de: 'Diese Person teilt diesen Teil nicht mit dir.',
  },
  MONTH_LISTS_LIMIT: {
    pt: 'Este mês já tem o máximo de listas ({max}).',
    en: 'This month already has the maximum number of lists ({max}).',
    fr: 'Ce mois a déjà le maximum de listes ({max}).',
    de: 'Dieser Monat hat bereits die maximale Anzahl an Listen ({max}).',
  },
  GOAL_DEPOSITS_LIMIT: {
    pt: 'Este objetivo já tem o máximo de depósitos planeados ({max}).',
    en: 'This goal already has the maximum number of planned deposits ({max}).',
    fr: 'Cet objectif a déjà le maximum de dépôts prévus ({max}).',
    de: 'Dieses Ziel hat bereits die maximale Anzahl geplanter Einzahlungen ({max}).',
  },
  CONTRIBUTION_NOT_FOUND: { pt: 'Contribuição não encontrada.', en: 'Contribution not found.', fr: 'Contribution introuvable.', de: 'Einzahlung nicht gefunden.' },

  PREMIUM_REQUIRED: {
    pt: 'Esta funcionalidade faz parte do Premium.',
    en: 'This feature is part of Premium.',
    fr: 'Cette fonctionnalité fait partie de Premium.',
    de: 'Diese Funktion gehört zu Premium.',
  },
  PLAN_LIMIT_REACHED: {
    pt: 'Chegaste ao limite do teu plano ({max}). Com o Premium tens mais.',
    en: 'You’ve reached your plan’s limit ({max}). Premium gives you more.',
    fr: 'Tu as atteint la limite de ton offre ({max}). Premium t’en donne plus.',
    de: 'Du hast das Limit deines Tarifs erreicht ({max}). Mit Premium bekommst du mehr.',
  },
  PLAN_ITEM_LOCKED: {
    pt: 'Isto foi criado com um plano pago que já não tens. Volta a ativá-lo para o abrires.',
    en: 'This was created with a paid plan you no longer have. Reactivate it to open this again.',
    fr: 'Ceci a été créé avec une offre payante que tu n’as plus. Réactive-la pour le rouvrir.',
    de: 'Das wurde mit einem kostenpflichtigen Tarif erstellt, den du nicht mehr hast. Aktiviere ihn wieder, um es zu öffnen.',
  },
  REPORT_RANGE_LIMIT: {
    pt: 'No plano grátis, os relatórios vão até {months} meses atrás.',
    en: 'On the free plan, reports go back {months} months.',
    fr: 'Avec l’offre gratuite, les rapports remontent à {months} mois.',
    de: 'Im kostenlosen Tarif reichen Berichte {months} Monate zurück.',
  },
  EXPORT_RANGE_LIMIT: {
    pt: 'No plano grátis, exportas até {days} dias de cada vez.',
    en: 'On the free plan, you can export up to {days} days at a time.',
    fr: 'Avec l’offre gratuite, tu peux exporter jusqu’à {days} jours à la fois.',
    de: 'Im kostenlosen Tarif kannst du bis zu {days} Tage auf einmal exportieren.',
  },
  STORAGE_NOT_CONFIGURED: { pt: 'O armazenamento de ficheiros ainda não está configurado.', en: 'File storage is not configured yet.', fr: 'Le stockage des fichiers n’est pas encore configuré.', de: 'Der Dateispeicher ist noch nicht eingerichtet.' },
  WHATSAPP_NOT_CONFIGURED: { pt: 'A ligação ao WhatsApp ainda não está configurada no servidor.', en: 'The WhatsApp connection is not configured on the server yet.', fr: 'La connexion WhatsApp n’est pas encore configurée sur le serveur.', de: 'Die WhatsApp-Anbindung ist auf dem Server noch nicht eingerichtet.' },
  PENDING_ALREADY_DONE: { pt: 'Este movimento já foi tratado.', en: 'This transaction was already handled.', fr: 'Cette opération a déjà été traitée.', de: 'Diese Buchung wurde bereits bearbeitet.' },
  IMPORT_NOT_FOUND: { pt: 'Esta importação já não existe. Carrega o ficheiro outra vez.', en: 'This import no longer exists. Upload the file again.', fr: 'Cette importation n’existe plus. Recharge le fichier.', de: 'Dieser Import existiert nicht mehr. Lade die Datei erneut hoch.' },
  IMPORT_UNREADABLE: { pt: 'Não consegui ler este ficheiro. Usa um CSV ou um XLSX.', en: 'Could not read this file. Use a CSV or an XLSX.', fr: 'Impossible de lire ce fichier. Utilise un CSV ou un XLSX.', de: 'Diese Datei konnte nicht gelesen werden. Nutze eine CSV- oder XLSX-Datei.' },
  IMPORT_EMPTY: { pt: 'O ficheiro não tem linhas para importar.', en: 'The file has no rows to import.', fr: 'Le fichier ne contient aucune ligne à importer.', de: 'Die Datei enthält keine Zeilen zum Importieren.' },
  IMPORT_ALREADY_DONE: { pt: 'Esta importação já foi feita.', en: 'This import was already done.', fr: 'Cette importation a déjà été faite.', de: 'Dieser Import wurde bereits durchgeführt.' },
  INVESTMENT_NOT_FOUND: { pt: 'Investimento não encontrado.', en: 'Investment not found.', fr: 'Investissement introuvable.', de: 'Anlage nicht gefunden.' },
  LOGIN_LOCKED: { pt: 'Muitas tentativas falhadas. Espera {minutes} minutos e tenta outra vez.', en: 'Too many failed attempts. Wait {minutes} minutes and try again.', fr: 'Trop de tentatives échouées. Attends {minutes} minutes et réessaie.', de: 'Zu viele Fehlversuche. Warte {minutes} Minuten und versuch es erneut.' },
  AI_RATE_LIMIT: { pt: 'Muitos pedidos de IA seguidos. Podes voltar a usar daqui a {minutes} min.', en: 'Too many AI requests in a row. You can use it again in {minutes} min.', fr: 'Trop de demandes d’IA d’affilée. Tu pourras réessayer dans {minutes} min.', de: 'Zu viele KI-Anfragen hintereinander. In {minutes} Min. geht es weiter.' },
  AI_NOT_CONFIGURED: {
    pt: 'O assistente de IA ainda não está disponível.',
    en: 'The AI assistant isn’t available yet.',
    fr: 'L’assistant IA n’est pas encore disponible.',
    de: 'Der KI-Assistent ist noch nicht verfügbar.',
  },
  AI_QUOTA_REACHED: {
    pt: 'Já usaste as {max} utilizações deste mês. Voltam no início do próximo mês.',
    en: 'You’ve used all {max} uses for this month. They reset at the start of next month.',
    fr: 'Tu as utilisé tes {max} utilisations de ce mois. Elles reviennent au début du mois prochain.',
    de: 'Du hast alle {max} Nutzungen dieses Monats verbraucht. Anfang nächsten Monats sind sie wieder da.',
  },
  AI_BUDGET_REACHED: {
    pt: 'A IA está muito procurada e ficou em pausa por agora. Tenta mais tarde.',
    en: 'The AI is in high demand and is paused for now. Please try again later.',
    fr: 'L’IA est très sollicitée et est en pause pour le moment. Réessaie plus tard.',
    de: 'Die KI ist gerade stark gefragt und pausiert. Bitte versuche es später erneut.',
  },
  AI_FAILED: {
    pt: 'O assistente não conseguiu responder. Tenta novamente.',
    en: 'The assistant couldn’t answer. Please try again.',
    fr: 'L’assistant n’a pas pu répondre. Réessaie.',
    de: 'Der Assistent konnte nicht antworten. Bitte versuche es erneut.',
  },
  SCAN_FAILED: {
    pt: 'Não conseguimos ler a imagem. Tenta com mais luz e enquadrada.',
    en: 'We couldn’t read the image. Try again with more light and framing.',
    fr: 'Impossible de lire l’image. Réessaie avec plus de lumière et bien cadrée.',
    de: 'Das Bild konnte nicht gelesen werden. Versuche es mit mehr Licht und gut ausgerichtet.',
  },
  FILE_TOO_LARGE: {
    pt: 'O ficheiro é demasiado grande (máx. {max} MB).',
    en: 'The file is too large (max {max} MB).',
    fr: 'Le fichier est trop volumineux (max. {max} Mo).',
    de: 'Die Datei ist zu groß (max. {max} MB).',
  },
  FILE_TYPE_NOT_ALLOWED: {
    pt: 'Tipo de ficheiro não suportado (usa JPG, PNG, WEBP, HEIC ou PDF).',
    en: 'Unsupported file type (use JPG, PNG, WEBP, HEIC or PDF).',
    fr: 'Type de fichier non pris en charge (JPG, PNG, WEBP, HEIC ou PDF).',
    de: 'Dateityp nicht unterstützt (JPG, PNG, WEBP, HEIC oder PDF).',
  },
  SAME_ACCOUNT_TRANSFER: {
    pt: 'Escolhe contas diferentes para transferir.',
    en: 'Choose two different accounts to transfer.',
    fr: 'Choisis deux comptes différents pour le virement.',
    de: 'Wähle zwei verschiedene Konten für die Überweisung.',
  },
  TRANSFER_TARGET_REQUIRED: {
    pt: 'Escolhe a conta de destino.',
    en: 'Choose the destination account.',
    fr: 'Choisis le compte de destination.',
    de: 'Wähle das Zielkonto.',
  },
  ACCOUNT_HAS_TRANSACTIONS: {
    pt: 'Esta conta tem {count} movimento(s). Arquiva-a ou apaga-a com os movimentos.',
    en: 'This account has {count} transaction(s). Archive it or delete it with its transactions.',
    fr: 'Ce compte a {count} opération(s). Archive-le ou supprime-le avec ses opérations.',
    de: 'Dieses Konto hat {count} Buchung(en). Archiviere es oder lösche es mit den Buchungen.',
  },
  ACCOUNT_CURRENCY_LOCKED: {
    pt: 'Não dá para mudar a moeda de uma conta que já tem movimentos.',
    en: 'You can’t change the currency of an account that already has transactions.',
    fr: 'Impossible de changer la devise d’un compte qui a déjà des opérations.',
    de: 'Die Währung eines Kontos mit Buchungen kann nicht geändert werden.',
  },
  ACCOUNT_ARCHIVED: {
    pt: 'Esta conta está arquivada.',
    en: 'This account is archived.',
    fr: 'Ce compte est archivé.',
    de: 'Dieses Konto ist archiviert.',
  },
  CATEGORY_TYPE_MISMATCH: {
    pt: 'A categoria não é do tipo certo (receita/despesa).',
    en: 'The category doesn’t match the type (income/expense).',
    fr: 'La catégorie ne correspond pas au type (revenu/dépense).',
    de: 'Die Kategorie passt nicht zum Typ (Einnahme/Ausgabe).',
  },
  DATE_RANGE_INVALID: {
    pt: 'O intervalo de datas não é válido.',
    en: 'The date range is not valid.',
    fr: 'La période n’est pas valide.',
    de: 'Der Zeitraum ist ungültig.',
  },
  NOT_SPACE_MEMBER: {
    pt: 'Não fazes parte deste Space.',
    en: 'You’re not part of this Space.',
    fr: 'Tu ne fais pas partie de cet espace.',
    de: 'Du bist kein Mitglied dieses Space.',
  },
  SPACE_ADMIN_REQUIRED: {
    pt: 'Só os admins do Space podem fazer isto.',
    en: 'Only Space admins can do this.',
    fr: 'Seuls les admins de l’espace peuvent faire cela.',
    de: 'Nur Space-Admins können das tun.',
  },
  SPACE_OWNER_REQUIRED: {
    pt: 'Só o dono do Space pode fazer isto.',
    en: 'Only the Space owner can do this.',
    fr: 'Seul le propriétaire de l’espace peut faire cela.',
    de: 'Nur der Space-Eigentümer kann das tun.',
  },
  ALREADY_MEMBER: {
    pt: 'Esta pessoa já faz parte do Space.',
    en: 'This person is already in the Space.',
    fr: 'Cette personne fait déjà partie de l’espace.',
    de: 'Diese Person ist bereits im Space.',
  },
  INVITE_CODE_INVALID: {
    pt: 'Código de convite inválido.',
    en: 'Invalid invite code.',
    fr: 'Code d’invitation invalide.',
    de: 'Ungültiger Einladungscode.',
  },
  INVITATION_CLOSED: {
    pt: 'Este convite já não está ativo.',
    en: 'This invitation is no longer active.',
    fr: 'Cette invitation n’est plus active.',
    de: 'Diese Einladung ist nicht mehr aktiv.',
  },
  CANNOT_INVITE_SELF: {
    pt: 'Não te podes convidar a ti próprio.',
    en: 'You can’t invite yourself.',
    fr: 'Tu ne peux pas t’inviter toi-même.',
    de: 'Du kannst dich nicht selbst einladen.',
  },
  SPACE_BALANCE_NOT_SETTLED: {
    pt: 'Ainda há contas por acertar neste Space ({amount}).',
    en: 'There are still balances to settle in this Space ({amount}).',
    fr: 'Il reste des comptes à régler dans cet espace ({amount}).',
    de: 'In diesem Space sind noch Beträge offen ({amount}).',
  },
  SPACE_POT_INSUFFICIENT: {
    pt: 'O fundo só tem {amount} livres. O que está guardado para metas só se gasta depois de libertar a meta.',
    en: 'The fund only has {amount} available. Money set aside for goals can only be spent after releasing the goal.',
    fr: 'La cagnotte n’a que {amount} de disponible. L’argent réservé aux objectifs ne se dépense qu’après avoir libéré l’objectif.',
    de: 'In der Kasse sind nur {amount} frei. Für Ziele zurückgelegtes Geld kann erst ausgegeben werden, wenn das Ziel freigegeben ist.',
  },
  SPACE_POT_NOT_SETTLED: {
    pt: 'Ainda tens contas por acertar com o fundo ({amount}). Levanta ou repõe a tua parte antes de sair.',
    en: 'You still have a balance with the fund ({amount}). Withdraw or pay back your part before leaving.',
    fr: 'Tu as encore un solde avec la cagnotte ({amount}). Retire ou rembourse ta part avant de partir.',
    de: 'Du hast noch einen offenen Betrag in der Kasse ({amount}). Hebe deinen Anteil ab oder gleiche ihn aus, bevor du gehst.',
  },
  SPACE_WITHDRAW_TOO_HIGH: {
    pt: 'Só podes levantar até {max}.',
    en: 'You can only withdraw up to {max}.',
    fr: 'Tu ne peux retirer que jusqu’à {max}.',
    de: 'Du kannst höchstens {max} abheben.',
  },
  SPACE_GOAL_NOT_FOUND: { pt: 'Meta não encontrada.', en: 'Goal not found.', fr: 'Objectif introuvable.', de: 'Ziel nicht gefunden.' },
  SPACE_DEPOSIT_NOT_FOUND: { pt: 'Depósito não encontrado.', en: 'Deposit not found.', fr: 'Dépôt introuvable.', de: 'Einzahlung nicht gefunden.' },
  SPACE_GOALS_LIMIT: {
    pt: 'Um Space pode ter até {max} metas abertas. Fecha uma para criar outra.',
    en: 'A Space can have up to {max} open goals. Close one to create another.',
    fr: 'Un espace peut avoir jusqu’à {max} objectifs ouverts. Ferme-en un pour en créer un autre.',
    de: 'Ein Space kann bis zu {max} offene Ziele haben. Schließe eines, um ein neues anzulegen.',
  },
  SPACE_ACCOUNT_CURRENCY: {
    pt: 'Não há câmbio entre a moeda do Space e a dessa conta. Escolhe outra conta.',
    en: 'There’s no exchange rate between the Space currency and that account. Choose another account.',
    fr: 'Il n’y a pas de taux de change entre la devise de l’espace et celle de ce compte. Choisis un autre compte.',
    de: 'Es gibt keinen Wechselkurs zwischen der Währung des Space und der dieses Kontos. Wähle ein anderes Konto.',
  },
  SPACE_PLAN_DUPLICATE: {
    pt: 'Cada categoria só pode aparecer uma vez no plano.',
    en: 'Each category can only appear once in the plan.',
    fr: 'Chaque catégorie ne peut apparaître qu’une fois dans le plan.',
    de: 'Jede Kategorie darf nur einmal im Plan vorkommen.',
  },
  CHAT_SELF: { pt: 'Não podes escrever a ti próprio.', en: 'You can’t message yourself.', fr: 'Tu ne peux pas t’écrire à toi-même.', de: 'Du kannst dir nicht selbst schreiben.' },
  CHAT_NOT_ALLOWED: {
    pt: 'Só podes escrever a pessoas com quem já tens alguma coisa em comum: um Space, um empréstimo ligado ou gastos partilhados.',
    en: 'You can only message people you already share something with: a Space, a linked loan or shared spending.',
    fr: 'Tu ne peux écrire qu’aux personnes avec qui tu as déjà quelque chose en commun : un espace, un prêt lié ou des dépenses partagées.',
    de: 'Du kannst nur Personen schreiben, mit denen du schon etwas gemeinsam hast: einen Space, ein verknüpftes Darlehen oder geteilte Ausgaben.',
  },
  MESSAGE_NOT_FOUND: { pt: 'Mensagem não encontrada.', en: 'Message not found.', fr: 'Message introuvable.', de: 'Nachricht nicht gefunden.' },
  CANNOT_REMOVE_OWNER: {
    pt: 'Não podes remover o dono do Space.',
    en: 'You can’t remove the Space owner.',
    fr: 'Tu ne peux pas retirer le propriétaire de l’espace.',
    de: 'Du kannst den Space-Eigentümer nicht entfernen.',
  },
  SPLIT_INVALID: {
    pt: 'A divisão não bate certo com o total ({total}).',
    en: 'The split doesn’t add up to the total ({total}).',
    fr: 'La répartition ne correspond pas au total ({total}).',
    de: 'Die Aufteilung ergibt nicht die Summe ({total}).',
  },
  SPLIT_MEMBER_INVALID: {
    pt: 'Só podes dividir com pessoas do Space.',
    en: 'You can only split with people in the Space.',
    fr: 'Tu ne peux partager qu’avec des membres de l’espace.',
    de: 'Du kannst nur mit Space-Mitgliedern teilen.',
  },
  SETTLEMENT_INVALID: {
    pt: 'Escolhe duas pessoas diferentes do Space.',
    en: 'Choose two different people in the Space.',
    fr: 'Choisis deux personnes différentes de l’espace.',
    de: 'Wähle zwei verschiedene Personen im Space.',
  },
  BILLING_NOT_CONFIGURED: {
    pt: 'Os pagamentos ainda não estão configurados.',
    en: 'Payments aren’t configured yet.',
    fr: 'Les paiements ne sont pas encore configurés.',
    de: 'Zahlungen sind noch nicht eingerichtet.',
  },

  // Empréstimos
  LOAN_NOT_FOUND: { pt: 'Empréstimo não encontrado.', en: 'Loan not found.', fr: 'Prêt introuvable.', de: 'Darlehen nicht gefunden.' },
  LOAN_PAYMENT_NOT_FOUND: { pt: 'Devolução não encontrada.', en: 'Repayment not found.', fr: 'Remboursement introuvable.', de: 'Rückzahlung nicht gefunden.' },
  LOAN_AMOUNT_BELOW_PAID: {
    pt: 'O valor não pode ser menor do que o que já foi devolvido.',
    en: 'The amount can’t be lower than what has already been repaid.',
    fr: 'Le montant ne peut pas être inférieur à ce qui a déjà été remboursé.',
    de: 'Der Betrag darf nicht kleiner sein als das, was schon zurückgezahlt wurde.',
  },
  LOAN_CLOSED: {
    pt: 'Este empréstimo já está fechado.',
    en: 'This loan is already closed.',
    fr: 'Ce prêt est déjà clôturé.',
    de: 'Dieses Darlehen ist bereits abgeschlossen.',
  },
  LOAN_PAYMENT_TOO_HIGH: {
    pt: 'Só faltam {max}. A devolução não pode ser maior.',
    en: 'Only {max} is left. The repayment can’t be higher.',
    fr: 'Il ne reste que {max}. Le remboursement ne peut pas être supérieur.',
    de: 'Es sind nur noch {max} offen. Die Rückzahlung darf nicht höher sein.',
  },
  LOAN_CURRENCY_MISMATCH: {
    pt: 'Escolhe uma conta na mesma moeda do empréstimo.',
    en: 'Choose an account in the same currency as the loan.',
    fr: 'Choisis un compte dans la même devise que le prêt.',
    de: 'Wähle ein Konto in derselben Währung wie das Darlehen.',
  },

  // Plano mensal
  MONTHLY_PLAN_NOT_FOUND: {
    pt: 'Ainda não há plano para esse mês.',
    en: 'There is no plan for that month yet.',
    fr: 'Il n’y a pas encore de plan pour ce mois.',
    de: 'Für diesen Monat gibt es noch keinen Plan.',
  },
  MONTHLY_PLAN_CLOSED: {
    pt: 'Esse mês já acabou: só dá para planear o mês atual e os seguintes.',
    en: 'That month is over: you can only plan the current month and the ones ahead.',
    fr: 'Ce mois est terminé : tu peux seulement planifier le mois en cours et les suivants.',
    de: 'Dieser Monat ist vorbei: Planen kannst du nur den laufenden und die kommenden Monate.',
  },
  MONTHLY_PLAN_TOO_FAR: {
    pt: 'Só dá para planear até dois anos à frente.',
    en: 'You can plan up to two years ahead.',
    fr: 'Tu peux planifier jusqu’à deux ans à l’avance.',
    de: 'Du kannst bis zu zwei Jahre im Voraus planen.',
  },
  MONTHLY_PLAN_DUPLICATE_LINE: {
    pt: 'Cada categoria ou objetivo só pode aparecer uma vez no plano.',
    en: 'Each category or goal can only appear once in the plan.',
    fr: 'Chaque catégorie ou objectif ne peut apparaître qu’une fois dans le plan.',
    de: 'Jede Kategorie und jedes Ziel darf im Plan nur einmal vorkommen.',
  },

  // Acompanhamento (partilhar os gastos com alguém)
  SHARE_NOT_FOUND: { pt: 'Partilha não encontrada.', en: 'Sharing not found.', fr: 'Partage introuvable.', de: 'Freigabe nicht gefunden.' },
  SHARE_NOTE_NOT_FOUND: { pt: 'Nota não encontrada.', en: 'Note not found.', fr: 'Note introuvable.', de: 'Notiz nicht gefunden.' },
  SHARE_ALREADY_EXISTS: {
    pt: 'Já partilhas os teus gastos com esta pessoa (ou o convite está à espera).',
    en: 'You already share your spending with this person (or the invitation is pending).',
    fr: 'Tu partages déjà tes dépenses avec cette personne (ou l’invitation est en attente).',
    de: 'Du teilst deine Ausgaben bereits mit dieser Person (oder die Einladung ist noch offen).',
  },
  SHARE_NOT_ACTIVE: {
    pt: 'Este convite ainda não foi aceite.',
    en: 'This invitation hasn’t been accepted yet.',
    fr: 'Cette invitation n’a pas encore été acceptée.',
    de: 'Diese Einladung wurde noch nicht angenommen.',
  },
  SHARE_SCOPE_SUMMARY: {
    pt: 'Esta partilha mostra só o resumo, sem a lista de movimentos.',
    en: 'This sharing only shows the summary, not the list of transactions.',
    fr: 'Ce partage n’affiche que le résumé, sans la liste des opérations.',
    de: 'Diese Freigabe zeigt nur die Übersicht, nicht die Liste der Buchungen.',
  },

  // Códigos promocionais e administração
  PROMO_CODE_INVALID: { pt: 'Este código não é válido.', en: 'This code isn’t valid.', fr: 'Ce code n’est pas valide.', de: 'Dieser Code ist ungültig.' },
  PROMO_CODE_EXPIRED: { pt: 'Este código já expirou.', en: 'This code has expired.', fr: 'Ce code a expiré.', de: 'Dieser Code ist abgelaufen.' },
  PROMO_CODE_EXHAUSTED: {
    pt: 'Este código já foi usado o número máximo de vezes.',
    en: 'This code has already been used the maximum number of times.',
    fr: 'Ce code a déjà été utilisé le nombre maximal de fois.',
    de: 'Dieser Code wurde bereits so oft wie möglich eingelöst.',
  },
  FEEDBACK_LIMIT: { pt: 'Já enviaste muitas mensagens hoje. Tenta amanhã.', en: 'You have sent many messages today. Try again tomorrow.', fr: 'Tu as déjà envoyé beaucoup de messages aujourd’hui. Réessaie demain.', de: 'Du hast heute schon viele Nachrichten gesendet. Versuch es morgen noch einmal.' },
  AREA_BLOCKED: { pt: 'Esta área não está incluída no teu código promocional.', en: 'This area is not included in your promo code.', fr: 'Cette partie n’est pas incluse dans ton code promotionnel.', de: 'Dieser Bereich ist in deinem Aktionscode nicht enthalten.' },
  PROMO_CODE_ALREADY_USED: { pt: 'Já usaste este código.', en: 'You’ve already used this code.', fr: 'Tu as déjà utilisé ce code.', de: 'Du hast diesen Code bereits eingelöst.' },
  PROMO_CODE_TAKEN: { pt: 'Já existe um código com esse nome.', en: 'A code with that name already exists.', fr: 'Un code portant ce nom existe déjà.', de: 'Ein Code mit diesem Namen existiert bereits.' },
  PROMO_CODE_NOT_FOUND: { pt: 'Código não encontrado.', en: 'Code not found.', fr: 'Code introuvable.', de: 'Code nicht gefunden.' },
  ADMIN_PROTECTED: {
    pt: 'O primeiro administrador não pode ser alterado por outro admin.',
    en: 'The first administrator cannot be changed by another admin.',
    fr: 'Le premier administrateur ne peut pas être modifié par un autre admin.',
    de: 'Der erste Administrator kann nicht von einem anderen Admin geändert werden.',
  },
  ADMIN_AREA_REQUIRED: {
    pt: 'Não tens acesso a esta área da administração.',
    en: 'You do not have access to this admin area.',
    fr: 'Tu n’as pas accès à cette partie de l’administration.',
    de: 'Du hast keinen Zugriff auf diesen Admin-Bereich.',
  },
  ADMIN_REQUIRED: {
    pt: 'Esta área é só para administradores.',
    en: 'This area is for administrators only.',
    fr: 'Cet espace est réservé aux administrateurs.',
    de: 'Dieser Bereich ist nur für Administratoren.',
  },
};

export function errorMessage(code: string, lang: Language, params?: Record<string, unknown>): string | null {
  return pick(ERRORS, code, lang, params);
}

// ------------------------------------------------------------------
// Categorias de base (para exportações e textos do servidor — a app
// tem as suas próprias traduções)
// ------------------------------------------------------------------

const CATEGORY_NAMES: Dict = {
  food: { pt: 'Alimentação', en: 'Food', fr: 'Alimentation', de: 'Essen' },
  groceries: { pt: 'Supermercado', en: 'Groceries', fr: 'Courses', de: 'Lebensmittel' },
  restaurants: { pt: 'Restaurantes', en: 'Restaurants', fr: 'Restaurants', de: 'Restaurants' },
  transport: { pt: 'Transporte', en: 'Transport', fr: 'Transport', de: 'Verkehr' },
  home: { pt: 'Casa', en: 'Home', fr: 'Logement', de: 'Wohnen' },
  bills: { pt: 'Contas da casa', en: 'Bills', fr: 'Factures', de: 'Rechnungen' },
  health: { pt: 'Saúde', en: 'Health', fr: 'Santé', de: 'Gesundheit' },
  education: { pt: 'Educação', en: 'Education', fr: 'Éducation', de: 'Bildung' },
  entertainment: { pt: 'Entretenimento', en: 'Entertainment', fr: 'Loisirs', de: 'Unterhaltung' },
  shopping: { pt: 'Compras', en: 'Shopping', fr: 'Shopping', de: 'Einkäufe' },
  technology: { pt: 'Tecnologia', en: 'Technology', fr: 'Technologie', de: 'Technik' },
  travel: { pt: 'Viagens', en: 'Travel', fr: 'Voyages', de: 'Reisen' },
  subscriptions: { pt: 'Subscrições', en: 'Subscriptions', fr: 'Abonnements', de: 'Abos' },
  personal_care: { pt: 'Cuidados pessoais', en: 'Personal care', fr: 'Soins personnels', de: 'Körperpflege' },
  gifts: { pt: 'Presentes', en: 'Gifts', fr: 'Cadeaux', de: 'Geschenke' },
  pets: { pt: 'Animais', en: 'Pets', fr: 'Animaux', de: 'Haustiere' },
  taxes: { pt: 'Impostos', en: 'Taxes', fr: 'Impôts', de: 'Steuern' },
  other_expense: { pt: 'Outros', en: 'Other', fr: 'Autres', de: 'Sonstiges' },
  salary: { pt: 'Salário', en: 'Salary', fr: 'Salaire', de: 'Gehalt' },
  freelance: { pt: 'Freelance', en: 'Freelance', fr: 'Freelance', de: 'Freiberuflich' },
  sale: { pt: 'Vendas', en: 'Sales', fr: 'Ventes', de: 'Verkäufe' },
  transfer_in: { pt: 'Transferências recebidas', en: 'Transfers received', fr: 'Virements reçus', de: 'Erhaltene Überweisungen' },
  bonus: { pt: 'Bónus', en: 'Bonus', fr: 'Prime', de: 'Bonus' },
  investments: { pt: 'Investimentos', en: 'Investments', fr: 'Investissements', de: 'Investitionen' },
  refunds: { pt: 'Reembolsos', en: 'Refunds', fr: 'Remboursements', de: 'Erstattungen' },
  other_income: { pt: 'Outras receitas', en: 'Other income', fr: 'Autres revenus', de: 'Sonstige Einnahmen' },
};

export function categoryName(key: string | null | undefined, lang: Language): string {
  if (!key) return pick(CATEGORY_NAMES, 'other_expense', lang) ?? key ?? '';
  return pick(CATEGORY_NAMES, key, lang) ?? key;
}

// ------------------------------------------------------------------
// Notificações (push) — título e texto
// ------------------------------------------------------------------

export const NOTIFICATIONS: Dict = {
  'help_change.title': { pt: '{from} ajudou na tua conta', en: '{from} helped with your account', fr: '{from} a aidé sur ton compte', de: '{from} hat in deinem Konto geholfen' },
  'help_change.body': { pt: '{what}', en: '{what}', fr: '{what}', de: '{what}' },
  'sharing_help.title': { pt: '{from} deixou-te ajudar a gerir', en: '{from} let you help manage their money', fr: '{from} te laisse aider à gérer', de: '{from} lässt dich mitverwalten' },
  'sharing_help.body': { pt: 'Já podes criar e alterar o que {from} te deixou.', en: 'You can now create and change what {from} allowed.', fr: 'Tu peux maintenant créer et modifier ce que {from} t’a permis.', de: 'Du kannst jetzt erstellen und ändern, was {from} erlaubt hat.' },
  'loan_nudge.title': { pt: '{from} lembrou-te de um empréstimo', en: '{from} sent you a loan reminder', fr: '{from} t’a envoyé un rappel de prêt', de: '{from} hat dich an ein Darlehen erinnert' },
  'loan_nudge.body': { pt: 'Faltam devolver {remaining}.{note}', en: '{remaining} left to pay back.{note}', fr: 'Il reste {remaining} à rembourser.{note}', de: 'Noch {remaining} zurückzuzahlen.{note}' },
  'loan_note.title': { pt: '{from} escreveu sobre o empréstimo', en: '{from} wrote about the loan', fr: '{from} a écrit au sujet du prêt', de: '{from} hat wegen des Darlehens geschrieben' },
  'loan_note.body': { pt: 'Ainda faltam {remaining}.{note}', en: '{remaining} still to go.{note}', fr: 'Il reste encore {remaining}.{note}', de: 'Noch {remaining} offen.{note}' },
  'space_reminder.title': { pt: '{from} lembrou-te de um acerto', en: '{from} sent you a reminder', fr: '{from} t’a envoyé un rappel', de: '{from} hat dich erinnert' },
  'space_reminder.body': { pt: 'No Space {space} deves {amount} a {from}.', en: 'In the {space} Space you owe {from} {amount}.', fr: 'Dans le Space {space}, tu dois {amount} à {from}.', de: 'Im Space {space} schuldest du {from} {amount}.' },
  'budget_alert.title': {
    pt: 'Orçamento {name}', en: '{name} budget', fr: 'Budget {name}', de: 'Budget {name}',
  },
  'budget_alert.body': {
    pt: 'Já usaste {percent}% ({spent} de {amount}).',
    en: 'You’ve used {percent}% ({spent} of {amount}).',
    fr: 'Tu as utilisé {percent} % ({spent} sur {amount}).',
    de: 'Du hast {percent} % verbraucht ({spent} von {amount}).',
  },
  'budget_exceeded.title': {
    pt: 'Orçamento {name} ultrapassado', en: '{name} budget exceeded', fr: 'Budget {name} dépassé', de: 'Budget {name} überschritten',
  },
  'budget_exceeded.body': {
    pt: 'Passaste o orçamento: {spent} de {amount}.',
    en: 'You went over budget: {spent} of {amount}.',
    fr: 'Tu as dépassé le budget : {spent} sur {amount}.',
    de: 'Budget überschritten: {spent} von {amount}.',
  },
  'payment_reminder.title': {
    pt: 'Pagamento a chegar', en: 'Upcoming payment', fr: 'Paiement à venir', de: 'Anstehende Zahlung',
  },
  'payment_reminder.body': {
    pt: '{description}: {amount} em {date}.',
    en: '{description}: {amount} on {date}.',
    fr: '{description} : {amount} le {date}.',
    de: '{description}: {amount} am {date}.',
  },
  'payment_created.title': {
    pt: 'Pagamento registado', en: 'Payment recorded', fr: 'Paiement enregistré', de: 'Zahlung erfasst',
  },
  'payment_created.body': {
    pt: '{description}: {amount} foi registado automaticamente.',
    en: '{description}: {amount} was recorded automatically.',
    fr: '{description} : {amount} a été enregistré automatiquement.',
    de: '{description}: {amount} wurde automatisch erfasst.',
  },
  'space_invite.title': {
    pt: 'Convite para um Space', en: 'Space invitation', fr: 'Invitation à un espace', de: 'Space-Einladung',
  },
  'space_invite.body': {
    pt: '{from} convidou-te para "{space}".',
    en: '{from} invited you to "{space}".',
    fr: '{from} t’a invité à « {space} ».',
    de: '{from} hat dich zu „{space}“ eingeladen.',
  },
  'space_expense.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'space_expense.body': {
    pt: '{from} adicionou "{title}" ({amount}). A tua parte: {share}.',
    en: '{from} added "{title}" ({amount}). Your share: {share}.',
    fr: '{from} a ajouté « {title} » ({amount}). Ta part : {share}.',
    de: '{from} hat „{title}“ hinzugefügt ({amount}). Dein Anteil: {share}.',
  },
  'space_settlement.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'space_settlement.body': {
    pt: '{from} registou um pagamento de {amount} para ti.',
    en: '{from} recorded a payment of {amount} to you.',
    fr: '{from} a enregistré un paiement de {amount} pour toi.',
    de: '{from} hat eine Zahlung von {amount} an dich erfasst.',
  },
  'space_joined.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'space_joined.body': {
    pt: '{from} entrou no Space.', en: '{from} joined the Space.', fr: '{from} a rejoint l’espace.', de: '{from} ist dem Space beigetreten.',
  },
  'goal_completed.title': {
    pt: 'Objetivo alcançado', en: 'Goal reached', fr: 'Objectif atteint', de: 'Ziel erreicht',
  },
  'goal_completed.body': {
    pt: 'Chegaste aos {amount} para "{name}".',
    en: 'You reached {amount} for "{name}".',
    fr: 'Tu as atteint {amount} pour « {name} ».',
    de: 'Du hast {amount} für „{name}“ erreicht.',
  },
  'whatsapp_pending.title': {
    pt: 'Movimento por confirmar', en: 'Transaction to confirm', fr: 'Opération à confirmer', de: 'Buchung zu bestätigen',
  },
  'whatsapp_pending.body': {
    pt: 'Chegou pelo WhatsApp: {summary}. Confirma para ficar guardado.',
    en: 'Received via WhatsApp: {summary}. Confirm to save it.',
    fr: 'Reçu via WhatsApp : {summary}. Confirme pour l’enregistrer.',
    de: 'Per WhatsApp eingegangen: {summary}. Bestätige, um es zu speichern.',
  },
  'ai_credits_added.title': {
    pt: 'Créditos de IA adicionados', en: 'AI credits added', fr: 'Crédits IA ajoutés', de: 'KI-Guthaben hinzugefügt',
  },
  'ai_credits_added.body': {
    pt: 'Tens mais {credits} créditos para usar quando a quota do período acabar.',
    en: 'You have {credits} more credits to use when the period quota runs out.',
    fr: 'Tu as {credits} crédits de plus à utiliser quand le quota de la période est épuisé.',
    de: 'Du hast {credits} zusätzliche Credits, wenn das Kontingent des Zeitraums aufgebraucht ist.',
  },
  'subscription_active.title': {
    pt: 'Bem-vindo ao {plan}', en: 'Welcome to {plan}', fr: 'Bienvenue dans {plan}', de: 'Willkommen bei {plan}',
  },
  'subscription_active.body': {
    pt: 'Já tens acesso a todas as ferramentas do teu plano.',
    en: 'You now have access to all the tools in your plan.',
    fr: 'Tu as maintenant accès à tous les outils de ton offre.',
    de: 'Du hast jetzt Zugriff auf alle Funktionen deines Tarifs.',
  },
  'subscription_ending.title': {
    pt: 'O teu {plan} acaba a {date}', en: 'Your {plan} ends on {date}', fr: 'Ton {plan} se termine le {date}', de: 'Dein {plan} endet am {date}',
  },
  'subscription_ending.body': {
    pt: 'Não renova sozinho. Prolonga-o para continuares a usar tudo o que criaste.',
    en: 'It will not renew by itself. Extend it to keep using everything you created.',
    fr: 'Il ne se renouvelle pas tout seul. Prolonge-le pour continuer à utiliser tout ce que tu as créé.',
    de: 'Er verlängert sich nicht von selbst. Verlängere ihn, um alles weiter zu nutzen, was du angelegt hast.',
  },
  'subscription_ended.title': {
    pt: 'O teu {plan} terminou', en: 'Your {plan} has ended', fr: 'Ton {plan} est terminé', de: 'Dein {plan} ist beendet',
  },
  'subscription_ended.body': {
    pt: 'O plano grátis continua a funcionar. Podes reativar o {plan} quando quiseres.',
    en: 'The free plan keeps working. You can reactivate {plan} whenever you like.',
    fr: 'L’offre gratuite continue de fonctionner. Tu peux réactiver {plan} quand tu veux.',
    de: 'Der kostenlose Tarif funktioniert weiter. Du kannst {plan} jederzeit wieder aktivieren.',
  },
  'subscription_ended_locked.title': {
    pt: 'O teu {plan} terminou', en: 'Your {plan} has ended', fr: 'Ton {plan} est terminé', de: 'Dein {plan} ist beendet',
  },
  'subscription_ended_locked.body': {
    pt: 'O que passava dos limites do plano grátis ficou fechado ({count}). Continua guardado: reativa o {plan} para o voltares a abrir.',
    en: 'What went beyond the free plan’s limits is now locked ({count}). It is still saved: reactivate {plan} to open it again.',
    fr: 'Ce qui dépassait les limites de l’offre gratuite est maintenant verrouillé ({count}). Tout est conservé : réactive {plan} pour le rouvrir.',
    de: 'Was über die Grenzen des kostenlosen Tarifs hinausging, ist jetzt gesperrt ({count}). Es bleibt gespeichert: Aktiviere {plan} wieder, um es zu öffnen.',
  },
  'subscription_billing_issue.title': {
    pt: 'Não foi possível cobrar a tua subscrição',
    en: 'Your subscription payment did not go through',
    fr: 'Le paiement de ton abonnement n’a pas abouti',
    de: 'Die Zahlung für dein Abo ist fehlgeschlagen',
  },
  'subscription_billing_issue.body': {
    pt: 'Atualiza o pagamento na loja para não perderes o {plan}.',
    en: 'Update your payment in the store so you do not lose {plan}.',
    fr: 'Mets à jour ton moyen de paiement dans la boutique pour ne pas perdre {plan}.',
    de: 'Aktualisiere deine Zahlungsmethode im Store, damit du {plan} nicht verlierst.',
  },
  'goal_deposit_due.title': {
    pt: 'Dia de pôr dinheiro de lado', en: 'Time to set money aside', fr: 'C’est le jour de mettre de côté', de: 'Zeit, etwas zurückzulegen',
  },
  'goal_deposit_due.body': {
    pt: 'Planeaste pôr {amount} em "{name}" hoje.',
    en: 'You planned to put {amount} into "{name}" today.',
    fr: 'Tu as prévu de mettre {amount} dans « {name} » aujourd’hui.',
    de: 'Du wolltest heute {amount} für „{name}“ zurücklegen.',
  },
  'goal_deposit_done.title': {
    pt: 'Depósito registado', en: 'Deposit recorded', fr: 'Dépôt enregistré', de: 'Einzahlung erfasst',
  },
  'goal_deposit_done.body': {
    pt: '{amount} entraram em "{name}", como planeado.',
    en: '{amount} went into "{name}", as planned.',
    fr: '{amount} ont été ajoutés à « {name} », comme prévu.',
    de: '{amount} wurden wie geplant für „{name}“ zurückgelegt.',
  },
  'goal_almost.title': {
    pt: 'Falta pouco', en: 'Almost there', fr: 'Tu y es presque', de: 'Fast geschafft',
  },
  'goal_almost.body': {
    pt: 'Só faltam {remaining} para "{name}".',
    en: 'Only {remaining} to go for "{name}".',
    fr: 'Il ne manque plus que {remaining} pour « {name} ».',
    de: 'Nur noch {remaining} bis „{name}“.',
  },
  'plan_line_exceeded.title': {
    pt: 'Plano do mês', en: 'Monthly plan', fr: 'Plan du mois', de: 'Monatsplan',
  },
  'plan_line_exceeded.body': {
    pt: 'Passaste o planeado em {name}: {actual} de {planned}.',
    en: 'You went over your plan for {name}: {actual} of {planned}.',
    fr: 'Tu as dépassé le prévu en {name} : {actual} sur {planned}.',
    de: 'Du hast den Plan für {name} überschritten: {actual} von {planned}.',
  },

  // Empréstimos: emprestei (devem-me)
  'loan_lent_due_soon.title': {
    pt: 'Empréstimo a receber', en: 'Loan to get back', fr: 'Prêt à récupérer', de: 'Darlehen zurückerwartet',
  },
  'loan_lent_due_soon.body': {
    pt: '{person} deve devolver-te {amount} até {date}.',
    en: '{person} should pay you back {amount} by {date}.',
    fr: '{person} doit te rembourser {amount} d’ici le {date}.',
    de: '{person} soll dir bis {date} {amount} zurückzahlen.',
  },
  'loan_lent_due_today.title': {
    pt: 'Empréstimo a receber hoje', en: 'Loan due back today', fr: 'Prêt à récupérer aujourd’hui', de: 'Darlehen heute fällig',
  },
  'loan_lent_due_today.body': {
    pt: 'É hoje: {person} deve devolver-te {amount}.',
    en: 'It’s today: {person} should pay you back {amount}.',
    fr: 'C’est aujourd’hui : {person} doit te rembourser {amount}.',
    de: 'Heute ist es so weit: {person} soll dir {amount} zurückzahlen.',
  },
  'loan_lent_overdue.title': {
    pt: 'Empréstimo em atraso', en: 'Loan overdue', fr: 'Prêt en retard', de: 'Darlehen überfällig',
  },
  'loan_lent_overdue.body': {
    pt: '{person} ainda não te devolveu {amount} (era até {date}).',
    en: '{person} still hasn’t paid you back {amount} (it was due {date}).',
    fr: '{person} ne t’a pas encore remboursé {amount} (c’était pour le {date}).',
    de: '{person} hat dir {amount} noch nicht zurückgezahlt (fällig war {date}).',
  },
  // Empréstimos: pedi emprestado (devo)
  'loan_borrowed_due_soon.title': {
    pt: 'Empréstimo a devolver', en: 'Loan to pay back', fr: 'Emprunt à rembourser', de: 'Darlehen zurückzuzahlen',
  },
  'loan_borrowed_due_soon.body': {
    pt: 'Tens de devolver {amount} a {person} até {date}.',
    en: 'You need to pay {person} back {amount} by {date}.',
    fr: 'Tu dois rembourser {amount} à {person} d’ici le {date}.',
    de: 'Du musst {person} bis {date} {amount} zurückzahlen.',
  },
  'loan_borrowed_due_today.title': {
    pt: 'Empréstimo a devolver hoje', en: 'Loan to pay back today', fr: 'Emprunt à rembourser aujourd’hui', de: 'Darlehen heute zurückzahlen',
  },
  'loan_borrowed_due_today.body': {
    pt: 'É hoje: tens de devolver {amount} a {person}.',
    en: 'It’s today: you need to pay {person} back {amount}.',
    fr: 'C’est aujourd’hui : tu dois rembourser {amount} à {person}.',
    de: 'Heute ist es so weit: Du musst {person} {amount} zurückzahlen.',
  },
  'loan_borrowed_overdue.title': {
    pt: 'Empréstimo em atraso', en: 'Loan overdue', fr: 'Emprunt en retard', de: 'Darlehen überfällig',
  },
  'loan_borrowed_overdue.body': {
    pt: 'Ainda não devolveste {amount} a {person} (era até {date}).',
    en: 'You still haven’t paid {person} back {amount} (it was due {date}).',
    fr: 'Tu n’as pas encore remboursé {amount} à {person} (c’était pour le {date}).',
    de: 'Du hast {person} {amount} noch nicht zurückgezahlt (fällig war {date}).',
  },

  // Acompanhamento
  'sharing_invite.title': {
    pt: 'Convite para acompanhar gastos', en: 'Invitation to follow spending', fr: 'Invitation à suivre des dépenses', de: 'Einladung zum Mitverfolgen',
  },
  'sharing_invite.body': {
    pt: '{from} quer partilhar contigo os gastos do mês.',
    en: '{from} wants to share their monthly spending with you.',
    fr: '{from} veut partager ses dépenses du mois avec toi.',
    de: '{from} möchte die monatlichen Ausgaben mit dir teilen.',
  },
  'sharing_accepted.title': {
    pt: 'Convite aceite', en: 'Invitation accepted', fr: 'Invitation acceptée', de: 'Einladung angenommen',
  },
  'sharing_accepted.body': {
    pt: '{from} já pode ver os teus gastos do mês.',
    en: '{from} can now see your monthly spending.',
    fr: '{from} peut maintenant voir tes dépenses du mois.',
    de: '{from} kann jetzt deine monatlichen Ausgaben sehen.',
  },
  'sharing_note.title': {
    pt: 'Nota de {from}', en: 'Note from {from}', fr: 'Note de {from}', de: 'Notiz von {from}',
  },
  'sharing_note.body': {
    pt: '{text}', en: '{text}', fr: '{text}', de: '{text}',
  },
  'account_deletion_cancelled.title': {
    pt: 'A tua conta fica',
    en: 'Your account stays',
    fr: 'Ton compte reste',
    de: 'Dein Konto bleibt',
  },
  'account_deletion_cancelled.body': {
    pt: 'Voltaste a entrar, por isso o pedido para apagar a conta foi cancelado.',
    en: 'You signed in again, so the request to delete your account was cancelled.',
    fr: 'Tu t’es reconnecté, la demande de suppression de ton compte a donc été annulée.',
    de: 'Du hast dich wieder angemeldet. Der Antrag auf Löschung deines Kontos wurde daher aufgehoben.',
  },
  'loan_request_borrowed.title': {
    pt: 'Empréstimo por confirmar',
    en: 'Loan to confirm',
    fr: 'Prêt à confirmer',
    de: 'Darlehen zu bestätigen',
  },
  'loan_request_borrowed.body': {
    pt: '{from} registou que te emprestou {amount}. Confirmas?',
    en: '{from} recorded lending you {amount}. Do you confirm?',
    fr: '{from} a noté t’avoir prêté {amount}. Tu confirmes ?',
    de: '{from} hat eingetragen, dir {amount} geliehen zu haben. Bestätigst du das?',
  },
  'loan_request_lent.title': {
    pt: 'Empréstimo por confirmar',
    en: 'Loan to confirm',
    fr: 'Prêt à confirmer',
    de: 'Darlehen zu bestätigen',
  },
  'loan_request_lent.body': {
    pt: '{from} registou que lhe emprestaste {amount}. Confirmas?',
    en: '{from} recorded borrowing {amount} from you. Do you confirm?',
    fr: '{from} a noté t’avoir emprunté {amount}. Tu confirmes ?',
    de: '{from} hat eingetragen, sich {amount} von dir geliehen zu haben. Bestätigst du das?',
  },
  'loan_accepted.title': {
    pt: 'Empréstimo confirmado',
    en: 'Loan confirmed',
    fr: 'Prêt confirmé',
    de: 'Darlehen bestätigt',
  },
  'loan_accepted.body': {
    pt: '{from} confirmou o empréstimo de {amount}. Agora veem os dois as devoluções.',
    en: '{from} confirmed the loan of {amount}. You both see the repayments now.',
    fr: '{from} a confirmé le prêt de {amount}. Vous voyez maintenant tous les deux les remboursements.',
    de: '{from} hat das Darlehen über {amount} bestätigt. Ihr seht jetzt beide die Rückzahlungen.',
  },
  'loan_declined.title': {
    pt: 'Empréstimo não confirmado',
    en: 'Loan not confirmed',
    fr: 'Prêt non confirmé',
    de: 'Darlehen nicht bestätigt',
  },
  'loan_declined.body': {
    pt: '{from} não confirmou o empréstimo de {amount}. Continua só na tua conta.',
    en: '{from} did not confirm the loan of {amount}. It stays in your account only.',
    fr: '{from} n’a pas confirmé le prêt de {amount}. Il reste uniquement dans ton compte.',
    de: '{from} hat das Darlehen über {amount} nicht bestätigt. Es bleibt nur in deinem Konto.',
  },
  'loan_left.title': {
    pt: 'Empréstimo',
    en: 'Loan',
    fr: 'Prêt',
    de: 'Darlehen',
  },
  'loan_left.body': {
    pt: '{from} deixou de acompanhar o empréstimo de {amount}.',
    en: '{from} stopped following the loan of {amount}.',
    fr: '{from} ne suit plus le prêt de {amount}.',
    de: '{from} verfolgt das Darlehen über {amount} nicht mehr.',
  },
  'loan_removed.title': {
    pt: 'Empréstimo removido',
    en: 'Loan removed',
    fr: 'Prêt supprimé',
    de: 'Darlehen entfernt',
  },
  'loan_removed.body': {
    pt: '{from} removeu o empréstimo de {amount} que partilhava contigo.',
    en: '{from} removed the loan of {amount} shared with you.',
    fr: '{from} a supprimé le prêt de {amount} partagé avec toi.',
    de: '{from} hat das mit dir geteilte Darlehen über {amount} entfernt.',
  },
  'loan_payment_lent.title': {
    pt: 'Devolução registada',
    en: 'Repayment recorded',
    fr: 'Remboursement enregistré',
    de: 'Rückzahlung erfasst',
  },
  'loan_payment_lent.body': {
    pt: '{from} registou que te devolveu {amount}. Faltam {remaining}.',
    en: '{from} recorded paying you back {amount}. {remaining} to go.',
    fr: '{from} a noté t’avoir remboursé {amount}. Il reste {remaining}.',
    de: '{from} hat eingetragen, dir {amount} zurückgezahlt zu haben. Offen sind noch {remaining}.',
  },
  'loan_payment_borrowed.title': {
    pt: 'Devolução registada',
    en: 'Repayment recorded',
    fr: 'Remboursement enregistré',
    de: 'Rückzahlung erfasst',
  },
  'loan_payment_borrowed.body': {
    pt: '{from} registou que lhe devolveste {amount}. Faltam {remaining}.',
    en: '{from} recorded that you paid back {amount}. {remaining} to go.',
    fr: '{from} a noté que tu lui as remboursé {amount}. Il reste {remaining}.',
    de: '{from} hat eingetragen, dass du {amount} zurückgezahlt hast. Offen sind noch {remaining}.',
  },
  'loan_settled.title': {
    pt: 'Empréstimo pago',
    en: 'Loan paid off',
    fr: 'Prêt remboursé',
    de: 'Darlehen beglichen',
  },
  'loan_settled.body': {
    pt: 'Com a devolução de {amount}, o empréstimo com {from} ficou todo pago.',
    en: 'With the repayment of {amount}, the loan with {from} is fully paid.',
    fr: 'Avec le remboursement de {amount}, le prêt avec {from} est entièrement réglé.',
    de: 'Mit der Rückzahlung von {amount} ist das Darlehen mit {from} vollständig beglichen.',
  },
  'loan_payment_removed.title': {
    pt: 'Devolução anulada',
    en: 'Repayment undone',
    fr: 'Remboursement annulé',
    de: 'Rückzahlung storniert',
  },
  'loan_payment_removed.body': {
    pt: '{from} anulou uma devolução de {amount}.',
    en: '{from} undid a repayment of {amount}.',
    fr: '{from} a annulé un remboursement de {amount}.',
    de: '{from} hat eine Rückzahlung über {amount} storniert.',
  },
  'loan_changed.title': {
    pt: 'Empréstimo alterado',
    en: 'Loan changed',
    fr: 'Prêt modifié',
    de: 'Darlehen geändert',
  },
  'loan_changed.body': {
    pt: '{from} alterou os dados do empréstimo (agora {amount}).',
    en: '{from} changed the loan details (now {amount}).',
    fr: '{from} a modifié le prêt (désormais {amount}).',
    de: '{from} hat das Darlehen geändert (jetzt {amount}).',
  },
  'loan_cancelled.title': {
    pt: 'Empréstimo encerrado',
    en: 'Loan closed',
    fr: 'Prêt clôturé',
    de: 'Darlehen abgeschlossen',
  },
  'loan_cancelled.body': {
    pt: '{from} deu o empréstimo de {amount} por encerrado.',
    en: '{from} closed the loan of {amount}.',
    fr: '{from} a clôturé le prêt de {amount}.',
    de: '{from} hat das Darlehen über {amount} abgeschlossen.',
  },
  'space_removed.title': {
    pt: '{space}',
    en: '{space}',
    fr: '{space}',
    de: '{space}',
  },
  'space_removed.body': {
    pt: '{from} removeu-te deste Space.',
    en: '{from} removed you from this Space.',
    fr: '{from} t’a retiré de cet espace.',
    de: '{from} hat dich aus diesem Space entfernt.',
  },
  'space_role.title': {
    pt: '{space}',
    en: '{space}',
    fr: '{space}',
    de: '{space}',
  },
  'space_role.body': {
    pt: '{from} mudou o teu papel neste Space.',
    en: '{from} changed your role in this Space.',
    fr: '{from} a changé ton rôle dans cet espace.',
    de: '{from} hat deine Rolle in diesem Space geändert.',
  },
  'space_expense_deleted.title': {
    pt: '{space}',
    en: '{space}',
    fr: '{space}',
    de: '{space}',
  },
  'space_expense_deleted.body': {
    pt: '{from} apagou a despesa «{title}» ({amount}).',
    en: '{from} deleted the expense “{title}” ({amount}).',
    fr: '{from} a supprimé la dépense « {title} » ({amount}).',
    de: '{from} hat die Ausgabe „{title}“ ({amount}) gelöscht.',
  },
  'plan_offer.title': {
    pt: 'Plano do mês',
    en: 'Monthly plan',
    fr: 'Plan du mois',
    de: 'Monatsplan',
  },
  'plan_offer.body': {
    pt: '{from} enviou-te um plano para {month}. Vê e decide se o queres usar.',
    en: '{from} sent you a plan for {month}. Take a look and decide whether to use it.',
    fr: '{from} t’a envoyé un plan pour {month}. Regarde et décide si tu veux l’utiliser.',
    de: '{from} hat dir einen Plan für {month} gesendet. Sieh ihn dir an und entscheide, ob du ihn nutzen willst.',
  },
  'plan_offer_accepted.title': {
    pt: 'Plano aceite',
    en: 'Plan accepted',
    fr: 'Plan accepté',
    de: 'Plan angenommen',
  },
  'plan_offer_accepted.body': {
    pt: '{from} passou a usar o plano que enviaste ({month}).',
    en: '{from} is now using the plan you sent ({month}).',
    fr: '{from} utilise maintenant le plan que tu as envoyé ({month}).',
    de: '{from} nutzt jetzt den Plan, den du gesendet hast ({month}).',
  },
  'plan_offer_declined.title': {
    pt: 'Plano não aceite',
    en: 'Plan not accepted',
    fr: 'Plan non accepté',
    de: 'Plan nicht angenommen',
  },
  'plan_offer_declined.body': {
    pt: '{from} preferiu não usar o plano que enviaste.',
    en: '{from} chose not to use the plan you sent.',
    fr: '{from} a préféré ne pas utiliser le plan que tu as envoyé.',
    de: '{from} möchte den gesendeten Plan nicht nutzen.',
  },
  'item_offer.title': {
    pt: '{from} enviou-te algo',
    en: '{from} sent you something',
    fr: '{from} t’a envoyé quelque chose',
    de: '{from} hat dir etwas gesendet',
  },
  'item_offer.body': {
    pt: '“{title}”. Vê e decide se o queres usar.',
    en: '“{title}”. Take a look and decide whether to use it.',
    fr: '« {title} ». Regarde et décide si tu veux l’utiliser.',
    de: '„{title}“. Sieh es dir an und entscheide, ob du es nutzen willst.',
  },
  'item_offer_accepted.title': {
    pt: 'Envio aceite',
    en: 'Accepted',
    fr: 'Envoi accepté',
    de: 'Angenommen',
  },
  'item_offer_accepted.body': {
    pt: '{from} passou a usar “{title}”.',
    en: '{from} is now using “{title}”.',
    fr: '{from} utilise maintenant « {title} ».',
    de: '{from} nutzt jetzt „{title}“.',
  },
  'item_offer_declined.title': {
    pt: 'Envio recusado',
    en: 'Declined',
    fr: 'Envoi refusé',
    de: 'Abgelehnt',
  },
  'item_offer_declined.body': {
    pt: '{from} preferiu não usar “{title}”.',
    en: '{from} chose not to use “{title}”.',
    fr: '{from} a préféré ne pas utiliser « {title} ».',
    de: '{from} möchte „{title}“ nicht nutzen.',
  },
  'daily_limit_warning.title': {
    pt: 'Quase no limite de hoje',
    en: 'Close to today’s limit',
    fr: 'Presque à la limite du jour',
    de: 'Fast am Tageslimit',
  },
  'daily_limit_warning.body': {
    pt: 'Já gastaste {spent} de {limit}. Faltam {left}.',
    en: 'You’ve spent {spent} of {limit}. {left} left.',
    fr: 'Tu as dépensé {spent} sur {limit}. Il reste {left}.',
    de: 'Du hast {spent} von {limit} ausgegeben. Noch {left} übrig.',
  },
  'daily_limit_reached.title': {
    pt: 'Chegaste ao limite de hoje',
    en: 'You’ve reached today’s limit',
    fr: 'Tu as atteint la limite du jour',
    de: 'Tageslimit erreicht',
  },
  'daily_limit_reached.body': {
    pt: 'Gastaste os {limit} de hoje.',
    en: 'You’ve spent today’s {limit}.',
    fr: 'Tu as dépensé les {limit} du jour.',
    de: 'Du hast die {limit} von heute ausgegeben.',
  },
  'daily_limit_exceeded.title': {
    pt: 'Passaste o limite de hoje',
    en: 'You’re over today’s limit',
    fr: 'Tu as dépassé la limite du jour',
    de: 'Tageslimit überschritten',
  },
  'daily_limit_exceeded.body': {
    pt: 'Gastaste {spent}: são {left} acima dos {limit} de hoje.',
    en: 'You’ve spent {spent}: {left} over today’s {limit}.',
    fr: 'Tu as dépensé {spent} : {left} de plus que les {limit} du jour.',
    de: 'Du hast {spent} ausgegeben: {left} über den {limit} von heute.',
  },
  'space_pot_expense.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'space_pot_expense.body': {
    pt: '{from} pagou "{title}" ({amount}) com o fundo. A tua parte: {share}.',
    en: '{from} paid "{title}" ({amount}) from the fund. Your share: {share}.',
    fr: '{from} a payé « {title} » ({amount}) avec la cagnotte. Ta part : {share}.',
    de: '{from} hat „{title}“ ({amount}) aus der Kasse bezahlt. Dein Anteil: {share}.',
  },
  'space_deposit.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'space_deposit.body': {
    pt: '{from} pôs {amount} no fundo.',
    en: '{from} added {amount} to the fund.',
    fr: '{from} a mis {amount} dans la cagnotte.',
    de: '{from} hat {amount} in die Kasse eingezahlt.',
  },
  'space_deposit_goal.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'space_deposit_goal.body': {
    pt: '{from} pôs {amount} na meta "{goal}".',
    en: '{from} added {amount} to the goal "{goal}".',
    fr: '{from} a mis {amount} dans l’objectif « {goal} ».',
    de: '{from} hat {amount} für das Ziel „{goal}“ eingezahlt.',
  },
  'space_withdrawal.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'space_withdrawal.body': {
    pt: '{from} tirou {amount} do fundo.',
    en: '{from} withdrew {amount} from the fund.',
    fr: '{from} a retiré {amount} de la cagnotte.',
    de: '{from} hat {amount} aus der Kasse abgehoben.',
  },
  'space_deposit_removed.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'space_deposit_removed.body': {
    pt: '{from} anulou um movimento teu no fundo ({amount}).',
    en: '{from} removed one of your fund entries ({amount}).',
    fr: '{from} a annulé un de tes mouvements dans la cagnotte ({amount}).',
    de: '{from} hat eine deiner Buchungen in der Kasse storniert ({amount}).',
  },
  'space_goal_created.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'space_goal_created.body': {
    pt: '{from} criou a meta "{goal}" ({amount}).',
    en: '{from} created the goal "{goal}" ({amount}).',
    fr: '{from} a créé l’objectif « {goal} » ({amount}).',
    de: '{from} hat das Ziel „{goal}“ angelegt ({amount}).',
  },
  'space_goal_reached.title': {
    pt: 'Meta alcançada', en: 'Goal reached', fr: 'Objectif atteint', de: 'Ziel erreicht',
  },
  'space_goal_reached.body': {
    pt: '"{space}" juntou {amount} para "{goal}".',
    en: '"{space}" saved {amount} for "{goal}".',
    fr: '« {space} » a réuni {amount} pour « {goal} ».',
    de: '„{space}“ hat {amount} für „{goal}“ zusammen.',
  },
  'chat_message.title': {
    pt: '{space}', en: '{space}', fr: '{space}', de: '{space}',
  },
  'chat_message.body': {
    pt: '{from}: {text}', en: '{from}: {text}', fr: '{from} : {text}', de: '{from}: {text}',
  },
  'chat_direct.title': {
    pt: '{from}', en: '{from}', fr: '{from}', de: '{from}',
  },
  'chat_direct.body': {
    pt: '{text}', en: '{text}', fr: '{text}', de: '{text}',
  },
};

export function notificationText(type: string, part: 'title' | 'body', lang: Language, params?: Record<string, unknown>): string {
  return pick(NOTIFICATIONS, `${type}.${part}`, lang, params) ?? '';
}

// ------------------------------------------------------------------
// Email do código de recuperação
// ------------------------------------------------------------------

export const MAIL: Dict = {
  'deletion.subject': {
    pt: 'A tua conta do Contalexy vai ser apagada',
    en: 'Your Contalexy account will be deleted',
    fr: 'Ton compte Contalexy va être supprimé',
    de: 'Dein Contalexy-Konto wird gelöscht',
  },
  'deletion.body': {
    pt: 'Olá {name},\n\nRecebemos o teu pedido para apagar a conta. Ela fica guardada durante {days} dias e é apagada de vez no dia {date}, com todos os teus dados.\n\nMudaste de ideias? Basta entrares outra vez no Contalexy antes desse dia e o pedido é cancelado.\n\nSe não foste tu a pedir, entra na tua conta e muda a palavra-passe.',
    en: 'Hi {name},\n\nWe received your request to delete your account. It is kept for {days} days and will be permanently deleted on {date}, along with all your data.\n\nChanged your mind? Just sign in to Contalexy again before that day and the request is cancelled.\n\nIf this wasn’t you, sign in and change your password.',
    fr: 'Bonjour {name},\n\nNous avons reçu ta demande de suppression de compte. Il est conservé pendant {days} jours et sera définitivement supprimé le {date}, avec toutes tes données.\n\nTu as changé d’avis ? Il suffit de te reconnecter à Contalexy avant cette date et la demande est annulée.\n\nSi ce n’était pas toi, connecte-toi et change ton mot de passe.',
    de: 'Hallo {name},\n\nwir haben deinen Antrag auf Löschung deines Kontos erhalten. Es bleibt {days} Tage erhalten und wird am {date} mit all deinen Daten endgültig gelöscht.\n\nDu hast es dir anders überlegt? Melde dich einfach vor diesem Tag wieder bei Contalexy an, dann wird der Antrag aufgehoben.\n\nWenn du das nicht warst, melde dich an und ändere dein Passwort.',
  },
  'deletionCancelled.subject': {
    pt: 'A tua conta do Contalexy não vai ser apagada',
    en: 'Your Contalexy account will not be deleted',
    fr: 'Ton compte Contalexy ne sera pas supprimé',
    de: 'Dein Contalexy-Konto wird nicht gelöscht',
  },
  'deletionCancelled.body': {
    pt: 'Olá {name},\n\nVoltaste a entrar no Contalexy, por isso cancelámos o pedido para apagar a conta. Está tudo como deixaste.\n\nSe não foste tu a entrar, muda já a tua palavra-passe.',
    en: 'Hi {name},\n\nYou signed in to Contalexy again, so we cancelled the request to delete your account. Everything is as you left it.\n\nIf it wasn’t you who signed in, change your password now.',
    fr: 'Bonjour {name},\n\nTu t’es reconnecté à Contalexy, nous avons donc annulé la demande de suppression de ton compte. Tout est comme tu l’as laissé.\n\nSi ce n’était pas toi, change ton mot de passe tout de suite.',
    de: 'Hallo {name},\n\ndu hast dich wieder bei Contalexy angemeldet, daher haben wir den Antrag auf Löschung deines Kontos aufgehoben. Alles ist so, wie du es verlassen hast.\n\nWenn du das nicht warst, ändere jetzt dein Passwort.',
  },
  'deleted.subject': {
    pt: 'A tua conta do Contalexy foi apagada',
    en: 'Your Contalexy account has been deleted',
    fr: 'Ton compte Contalexy a été supprimé',
    de: 'Dein Contalexy-Konto wurde gelöscht',
  },
  'deleted.body': {
    pt: 'Olá {name},\n\nComo pediste, a tua conta e os teus dados foram apagados.\n\nObrigado por teres usado o Contalexy. Se quiseres voltar, é só criares uma conta nova.',
    en: 'Hi {name},\n\nAs you asked, your account and your data have been deleted.\n\nThank you for using Contalexy. If you want to come back, just create a new account.',
    fr: 'Bonjour {name},\n\nComme tu l’as demandé, ton compte et tes données ont été supprimés.\n\nMerci d’avoir utilisé Contalexy. Si tu veux revenir, il suffit de créer un nouveau compte.',
    de: 'Hallo {name},\n\nwie gewünscht wurden dein Konto und deine Daten gelöscht.\n\nDanke, dass du Contalexy genutzt hast. Wenn du zurückkommen möchtest, erstelle einfach ein neues Konto.',
  },
  'reset.subject': {
    pt: 'O teu código do Contalexy', en: 'Your Contalexy code', fr: 'Ton code Contalexy', de: 'Dein Contalexy-Code',
  },
  'reset.body': {
    pt: 'Olá {name},\n\nO teu código para criar uma nova palavra-passe é: {code}\n\nÉ válido durante 15 minutos. Se não foste tu, ignora este email.',
    en: 'Hi {name},\n\nYour code to set a new password is: {code}\n\nIt’s valid for 15 minutes. If this wasn’t you, ignore this email.',
    fr: 'Bonjour {name},\n\nTon code pour définir un nouveau mot de passe est : {code}\n\nIl est valable 15 minutes. Si ce n’était pas toi, ignore cet e-mail.',
    de: 'Hallo {name},\n\ndein Code für ein neues Passwort lautet: {code}\n\nEr ist 15 Minuten gültig. Wenn du das nicht warst, ignoriere diese E-Mail.',
  },
};

export function mailText(key: string, lang: Language, params?: Record<string, unknown>): string {
  return pick(MAIL, key, lang, params) ?? '';
}
