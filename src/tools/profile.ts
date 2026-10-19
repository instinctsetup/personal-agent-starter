// The user's application profile: the only source of answers for forms.
// The agent must never invent facts - unknown fields are asked, not guessed.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string; // city, country
  address: string;
  linkedin: string;
  github: string;
  portfolio: string;
  resumePath: string; // absolute path to the resume PDF on this machine
  coverLetter: string; // default text, editable per application
  currentCompany: string;
  currentTitle: string;
  yearsExperience: string;
  education: string;
  university: string;
  graduationYear: string;
  salaryExpectation: string;
  noticePeriod: string;
  workAuthorization: string;
  pronouns: string;
  website: string;
  extras: Record<string, string>; // anything else the user teaches the agent
}

export const EMPTY_PROFILE: Profile = {
  firstName: '', lastName: '', email: '', phone: '', location: '', address: '',
  linkedin: '', github: '', portfolio: '', resumePath: '', coverLetter: '',
  currentCompany: '', currentTitle: '', yearsExperience: '', education: '',
  university: '', graduationYear: '', salaryExpectation: '', noticePeriod: '',
  workAuthorization: '', pronouns: '', website: '', extras: {},
};

/** Human-readable labels used when asking the user for missing facts. */
export const PROFILE_LABELS: Record<keyof Omit<Profile, 'extras'>, string> = {
  firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone',
  location: 'Location (city, country)', address: 'Full address',
  linkedin: 'LinkedIn URL', github: 'GitHub URL', portfolio: 'Portfolio URL',
  resumePath: 'Resume PDF path on this computer', coverLetter: 'Default cover letter',
  currentCompany: 'Current/most recent company', currentTitle: 'Current/most recent title',
  yearsExperience: 'Years of experience', education: 'Highest degree',
  university: 'University', graduationYear: 'Graduation year',
  salaryExpectation: 'Salary expectation', noticePeriod: 'Notice period / earliest start',
  workAuthorization: 'Work authorization', pronouns: 'Pronouns', website: 'Personal website',
};

export class ProfileStore {
  readonly path: string;
  private profile: Profile;
  constructor(dir = join(process.cwd(), 'data')) {
    this.path = join(dir, 'profile.json');
    this.profile = existsSync(this.path)
      ? { ...structuredClone(EMPTY_PROFILE), ...JSON.parse(readFileSync(this.path, 'utf8')) }
      : structuredClone(EMPTY_PROFILE);
  }
  get(): Profile {
    return structuredClone(this.profile);
  }
  save(patch: Partial<Profile>): Profile {
    this.profile = { ...this.profile, ...patch, extras: { ...this.profile.extras, ...(patch.extras ?? {}) } };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.profile, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
    return this.get();
  }
}

export interface FormFieldSpec {
  kind: 'text' | 'textarea' | 'select' | 'file' | 'checkbox' | 'radio' | 'unknown';
  label: string; // best-effort human label
  required: boolean;
  options?: string[]; // for select/radio
}

/**
 * Maps a form field's textual signals (label, name, placeholder) to a profile
 * key. Pure and unit-tested; the browser layer feeds the signals in.
 * Returns undefined when nothing matches confidently - the agent asks instead.
 */
export function matchProfileKey(signals: string): keyof Profile | undefined {
  const s = signals.toLowerCase();
  const has = (...words: string[]) => words.some((w) => s.includes(w));
  if (has('resume', 'cv', 'curriculum')) return 'resumePath';
  if (has('cover letter', 'coverletter')) return 'coverLetter';
  if (has('first name', 'firstname', 'given name', 'fname')) return 'firstName';
  if (has('last name', 'lastname', 'surname', 'family name', 'lname')) return 'lastName';
  if (has('e-mail', 'email')) return 'email';
  if (has('phone', 'mobile', 'telephone', 'contact number')) return 'phone';
  if (has('linkedin')) return 'linkedin';
  if (has('github')) return 'github';
  if (has('portfolio', 'personal site', 'website', 'url')) return 'portfolio';
  if (has('current company', 'employer', 'organization', 'organisation')) return 'currentCompany';
  if (has('job title', 'current title', 'role', 'position')) return 'currentTitle';
  if (has('years of experience', 'experience')) return 'yearsExperience';
  if (has('university', 'college', 'school', 'institution')) return 'university';
  if (has('degree', 'education', 'qualification')) return 'education';
  if (has('graduation', 'grad year')) return 'graduationYear';
  if (has('salary', 'compensation', 'ctc', 'stipend', 'expected pay')) return 'salaryExpectation';
  if (has('notice', 'earliest start', 'start date', 'availability')) return 'noticePeriod';
  if (has('authori', 'visa', 'work permit', 'eligible to work')) return 'workAuthorization';
  if (has('pronoun')) return 'pronouns';
  if (has('address', 'street')) return 'address';
  if (has('city', 'location', 'where are you', 'reside')) return 'location';
  if (has('full name', 'your name', 'name')) return 'firstName'; // caller combines first+last for full-name fields
  return undefined;
}

/** Picks the best select/radio option for a profile value without inventing one. */
export function pickOption(value: string, options: string[]): string | undefined {
  const v = value.toLowerCase().trim();
  if (!v) return undefined;
  const exact = options.find((o) => o.toLowerCase().trim() === v);
  if (exact) return exact;
  const contained = options.find((o) => {
    const ol = o.toLowerCase().trim();
    return ol.includes(v) || v.includes(ol);
  });
  return contained;
}
