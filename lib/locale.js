/**
 * Langue par défaut (serveur) : UI via ui-config, e-mails, rapports, push.
 */

const SUPPORTED = new Set(['fr', 'en']);

const strings = {
  fr: {
    'notify.download': 'Télécharger',
    'notify.col.distribution': 'Distribution',
    'notify.col.iso': 'ISO',
    'notify.col.name': 'Nom',
    'notify.col.version': 'Version',
    'notify.col.architecture': 'Architecture',
    'notify.col.file': 'Fichier',
    'notify.col.size': 'Taille',
    'notify.col.detected': 'Détectée',
    'notify.col.link': 'Lien',
    'notify.col.reason': 'Motif',
    'notify.col.old_link': 'Ancien lien',
    'notify.test.title': 'Test ISO Watcher',
    'notify.test.body': 'Message de test envoyé par ISO Watcher.',
    'notify.hourly.title': 'Résumé horaire - {count} ISO',
    'notify.hourly.subject': 'Résumé horaire ISO Watcher - {count} version(s)',
    'notify.hourly.intro': '<p><strong>Résumé horaire</strong> - {count} nouvelle(s) version(s) détectée(s) depuis la dernière heure.</p>',
    'notify.hourly.summary': 'Résumé horaire - {count} version(s).',
    'notify.hourly.footer': 'Résumé horaire ISO Watcher',
    'notify.daily.title': 'Résumé quotidien - {count} ISO',
    'notify.daily.subject': 'Résumé quotidien ISO Watcher - {count} version(s)',
    'notify.daily.intro': '<p><strong>Résumé quotidien</strong> - {count} nouvelle(s) version(s) détectée(s) depuis le dernier envoi.</p>',
    'notify.daily.summary': 'Résumé quotidien - {count} version(s).',
    'notify.daily.footer': 'Résumé quotidien ISO Watcher',
    'notify.new_one': 'Nouvelle ISO : {name}',
    'notify.new_many': '{count} nouvelles ISO détectées',
    'notify.new_email_title': 'Nouvelles ISO détectées',
    'notify.new_admin_title': 'Nouvelles ISO détectées (admin)',
    'notify.detected_intro': '<p>ISO Watcher a détecté {count} nouvelle(s) version(s).</p>',
    'notify.test_email_subject': '[Test] ISO Watcher',
    'notify.test_email_heading': 'Test ISO Watcher',
    'notify.test_intro': '<p><strong>Message de test</strong> envoyé par ISO Watcher.</p>',
    'notify.more_releases': '… et {count} autre(s).',
    'notify.discord.new_iso': 'Nouvelle ISO : {name}',
    'notify.discord.new_release': 'Nouvelle release',
    'notify.discord.version': 'Version : {version}',
    'notify.discord.arch': 'Architecture : {arch}',
    'notify.discord.arch_unknown': 'non précisée',
    'notify.discord.size': 'Taille : {size}',
    'notify.discord.file': 'Fichier : {file}',
    'notify.teams.unknown_version': 'version inconnue',
    'notify.teams.unknown_arch': 'architecture inconnue',
    'report.link.subject': '[ISO Watcher] Rapport liens - {date}',
    'report.link.title': 'Rapport administrateur - vérification des liens',
    'report.link.page_title': 'Rapport admin ISO Watcher',
    'report.link.summary': 'Synthèse des <strong>{period}</strong> et des liens invalides retirés.',
    'report.link.period': '{hours} dernières heures',
    'report.link.checked': 'Releases vérifiées',
    'report.link.valid': 'Liens valides',
    'report.link.removed': 'Releases retirées (lien mort)',
    'report.link.new_in_period': 'Nouvelles releases sur la période',
    'report.link.section_new': 'Nouvelles releases détectées',
    'report.link.section_removed': 'Releases retirées (lien invalide)',
    'report.link.none_new': 'Aucune nouvelle release détectée sur {period}.',
    'report.link.none_removed': 'Aucune release retirée lors de la vérification des liens.',
    'report.link.embed_title': 'Rapport ISO Watcher - vérification des liens',
    'report.link.embed_desc': 'Période : {hours} h\nVérifiées : {checked}\nRetirées : {removed}\nNouvelles : {new}',
    'report.link.summary_name': 'Rapport vérification des liens',
    'report.link.teams_title': 'Rapport ISO Watcher - liens',
    'report.link.teams_body': 'Vérifiées : {checked}, retirées : {removed}, nouvelles : {new}',
    'report.link.teams_period': 'Période (h)',
    'report.link.teams_removed': 'Retirées',
    'report.admin_new_one': '[ISO Watcher] Nouvelle ISO : {name}',
    'report.admin_new_many': '[ISO Watcher] {count} nouvelles ISO détectées',
    'report.teams_new_body': '{count} nouvelle(s) release(s) détectée(s).'
  },
  en: {
    'notify.download': 'Download',
    'notify.col.distribution': 'Distribution',
    'notify.col.iso': 'ISO',
    'notify.col.name': 'Name',
    'notify.col.version': 'Version',
    'notify.col.architecture': 'Architecture',
    'notify.col.file': 'File',
    'notify.col.size': 'Size',
    'notify.col.detected': 'Detected',
    'notify.col.link': 'Link',
    'notify.col.reason': 'Reason',
    'notify.col.old_link': 'Former link',
    'notify.test.title': 'ISO Watcher test',
    'notify.test.body': 'Test message sent by ISO Watcher.',
    'notify.hourly.title': 'Hourly summary - {count} ISO(s)',
    'notify.hourly.subject': 'ISO Watcher hourly summary - {count} release(s)',
    'notify.hourly.intro': '<p><strong>Hourly summary</strong> - {count} new release(s) detected in the last hour.</p>',
    'notify.hourly.summary': 'Hourly summary - {count} release(s).',
    'notify.hourly.footer': 'ISO Watcher hourly summary',
    'notify.daily.title': 'Daily summary - {count} ISO(s)',
    'notify.daily.subject': 'ISO Watcher daily summary - {count} release(s)',
    'notify.daily.intro': '<p><strong>Daily summary</strong> - {count} new release(s) since the last delivery.</p>',
    'notify.daily.summary': 'Daily summary - {count} release(s).',
    'notify.daily.footer': 'ISO Watcher daily summary',
    'notify.new_one': 'New ISO: {name}',
    'notify.new_many': '{count} new ISOs detected',
    'notify.new_email_title': 'New ISOs detected',
    'notify.new_admin_title': 'New ISOs detected (admin)',
    'notify.detected_intro': '<p>ISO Watcher detected {count} new release(s).</p>',
    'notify.test_email_subject': '[Test] ISO Watcher',
    'notify.test_email_heading': 'ISO Watcher test',
    'notify.test_intro': '<p><strong>Test message</strong> sent by ISO Watcher.</p>',
    'notify.more_releases': '… and {count} more.',
    'notify.discord.new_iso': 'New ISO: {name}',
    'notify.discord.new_release': 'New release',
    'notify.discord.version': 'Version: {version}',
    'notify.discord.arch': 'Architecture: {arch}',
    'notify.discord.arch_unknown': 'unspecified',
    'notify.discord.size': 'Size: {size}',
    'notify.discord.file': 'File: {file}',
    'notify.teams.unknown_version': 'unknown version',
    'notify.teams.unknown_arch': 'unknown architecture',
    'report.link.subject': '[ISO Watcher] Link report - {date}',
    'report.link.title': 'Administrator report - link verification',
    'report.link.page_title': 'ISO Watcher admin report',
    'report.link.summary': 'Summary for <strong>{period}</strong> and invalid links removed.',
    'report.link.period': 'last {hours} hours',
    'report.link.checked': 'Releases checked',
    'report.link.valid': 'Valid links',
    'report.link.removed': 'Releases removed (dead link)',
    'report.link.new_in_period': 'New releases in period',
    'report.link.section_new': 'New releases detected',
    'report.link.section_removed': 'Releases removed (invalid link)',
    'report.link.none_new': 'No new releases detected in {period}.',
    'report.link.none_removed': 'No releases removed during link verification.',
    'report.link.embed_title': 'ISO Watcher report - link verification',
    'report.link.embed_desc': 'Period: {hours} h\nChecked: {checked}\nRemoved: {removed}\nNew: {new}',
    'report.link.summary_name': 'Link verification report',
    'report.link.teams_title': 'ISO Watcher report - links',
    'report.link.teams_body': 'Checked: {checked}, removed: {removed}, new: {new}',
    'report.link.teams_period': 'Period (h)',
    'report.link.teams_removed': 'Removed',
    'report.admin_new_one': '[ISO Watcher] New ISO: {name}',
    'report.admin_new_many': '[ISO Watcher] {count} new ISOs detected',
    'report.teams_new_body': '{count} new release(s) detected.'
  }
};

export function parseLocale(value, defaultValue = 'fr') {
  const raw = String(value ?? '').trim().toLowerCase();

  if (raw === 'fr' || raw.startsWith('fr-')) return 'fr';
  if (raw === 'en' || raw.startsWith('en-')) return 'en';

  return SUPPORTED.has(defaultValue) ? defaultValue : 'fr';
}

export function localeBcp47(locale) {
  return parseLocale(locale) === 'en' ? 'en-GB' : 'fr-FR';
}

export function interpolate(template, vars) {
  if (!vars) return template;

  return String(template).replace(/\{(\w+)\}/g, (_, key) => (
    vars[key] != null ? String(vars[key]) : `{${key}}`
  ));
}

export function t(locale, key, vars) {
  const lang = parseLocale(locale);
  const value = strings[lang]?.[key] ?? strings.fr?.[key] ?? key;
  return interpolate(value, vars);
}

export function formatLocaleDate(locale, dateInput, options = {}) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return date.toLocaleDateString(localeBcp47(locale), {
    timeZone: 'Europe/Paris',
    ...options
  });
}

export function formatLocaleDateTime(locale, dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return date.toLocaleString(localeBcp47(locale), { timeZone: 'Europe/Paris' });
}
