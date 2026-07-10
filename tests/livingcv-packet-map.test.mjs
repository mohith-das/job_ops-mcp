// Canonical Federation Contract v1 — CareerPacketJson → LivingCV mapping tests.
//
// Cross-validates the mapper against a vendored subset of LivingCV's
// CareerPacketSchema. We can't import LivingCV's zod schema across repos, so
// the contract pins the shape here and `validateLivingCVShape` mirrors it
// (see src/core/livingcv_packet_map.ts). These tests pin every field that
// the contract enumerates.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapCareerPacketToLivingCV,
  splitPeriod,
  validateLivingCVShape,
} from '../dist/core/livingcv_packet_map.js';

const samplePacket = () => ({
  schema: 'jobops-federation-1.0',
  meta: { version: 3, generated_at: '2026-01-01T00:00:00.000Z', source_cv_hash: null, source_packet_version: null, lightcast_mapped: false },
  basics: {
    name:     'Ada Lovelace',
    email:    'ada@example.com',
    phone:    '+1-555-0100',
    location: { city: 'London', country: 'UK', timezone: 'Europe/London' },
    linkedin: 'https://www.linkedin.com/in/ada',
    github:   'https://github.com/ada',
    portfolio:'https://ada.example.com',
    summary:  'Mathematician and writer; first programmer.',
    headline: 'First programmer',
  },
  target_roles: { primary: ['Eng'], archetypes: [] },
  taglines: { pm: 'Product', swe: 'Engineer' },
  work: [
    {
      company: 'Analytical Engines Ltd',
      position: 'Programmer',
      period:  'May 2020 - Present',
      location: 'Remote',
      bullets: ['Designed the first algorithm.', 'Wrote the first note on computation.'],
      evidence: [],
    },
    {
      company: 'Babbage Co',
      position: 'Mathematician',
      period:  '2018 - 2020',
      location: 'London',
      bullets: ['Worked with Babbage.'],  // also exercises year-only split
      evidence: [],
    },
    {
      company: 'Ancient Co',
      position: 'Scientist',
      period:  'meaningless string that should not parse',
      location: '',
      bullets: ['Ancient bullets'],
      evidence: [],
    },
  ],
  projects: [
    { title: 'First Algorithm!', description: 'Note G.', tech: null },
    { title: '', description: '', tech: null },  // skipped (no name)
  ],
  education: [
    { title: 'BA Mathematics', org: 'University of London', year: '2017' },
  ],
  skills: [
    { category: 'Languages', items: [{ name: 'TypeScript', lightcast_id: null, confidence: 0 }] },
    { category: 'Math',      items: [{ name: 'Calculus',   lightcast_id: null, confidence: 0 }] },
  ],
  evidence: [],
  compensation: { target_range: '', currency: 'USD', minimum: '', location_flexibility: '' },
  narrative: { superpowers: [], likes: [], dislikes: [], proof_points: [] },
});

test('identity.fullName is required and equals basics.name', () => {
  const p = mapCareerPacketToLivingCV(samplePacket());
  assert.equal(p.identity.fullName, 'Ada Lovelace');
  assert.equal(p.version, '3');
});

test('identity maps contact + social URLs from basics', () => {
  const p = mapCareerPacketToLivingCV(samplePacket());
  assert.equal(p.identity.email,         'ada@example.com');
  assert.equal(p.identity.phone,         '+1-555-0100');
  assert.equal(p.identity.location,      'London, UK');
  assert.equal(p.identity.linkedinUrl,   'https://www.linkedin.com/in/ada');
  assert.equal(p.identity.githubUrl,     'https://github.com/ada');
  assert.equal(p.identity.portfolioUrl,  'https://ada.example.com');
});

test('identity omits empty optionals (no "" pollution)', () => {
  const empty = {
    schema: 'jobops-federation-1.0',
    meta: { version: 1, generated_at: '', source_cv_hash: null, source_packet_version: null, lightcast_mapped: false },
    basics: { name: 'A', email: '', phone: '', location: { city: '', country: '', timezone: '' }, linkedin: '', github: '', portfolio: '', summary: '', headline: '' },
    target_roles: { primary: [], archetypes: [] }, taglines: {}, work: [], projects: [], education: [],
    skills: [], evidence: [],
    compensation: { target_range: '', currency: 'USD', minimum: '', location_flexibility: '' },
    narrative: { superpowers: [], likes: [], dislikes: [], proof_points: [] },
  };
  const p = mapCareerPacketToLivingCV(empty);
  assert.equal(p.identity.fullName, 'A');
  assert.equal('email' in p.identity, false);
  assert.equal('phone' in p.identity, false);
  assert.equal('location' in p.identity, false);
});

test('taglines become {archetype, text}[] and entries with empty text are dropped', () => {
  const pkt = samplePacket();
  pkt.taglines = { pm: 'Product pitch', swe: '', ml: 'ML pitch' }; // swe dropped (empty)
  const p = mapCareerPacketToLivingCV(pkt);
  assert.ok(Array.isArray(p.taglines));
  assert.equal(p.taglines.length, 2);
  assert.equal(p.taglines.find(t => t.archetype === 'pm').text, 'Product pitch');
  assert.equal(p.taglines.find(t => t.archetype === 'ml').text, 'ML pitch');
  assert.equal(p.taglines.find(t => t.archetype === 'swe'), undefined);
});

test('experience maps period split + bullets array of {text}', () => {
  const p = mapCareerPacketToLivingCV(samplePacket());
  assert.equal(p.experience.length, 3);
  // First: "May 2020 - Present" → startDate=2020-05, endDate=undefined
  assert.equal(p.experience[0].company, 'Analytical Engines Ltd');
  assert.equal(p.experience[0].title,   'Programmer');
  assert.equal(p.experience[0].startDate, '2020-05');
  assert.equal('endDate' in p.experience[0], false, 'endDate omitted when "Present"');
  assert.deepEqual(p.experience[0].bullets, [
    { text: 'Designed the first algorithm.' },
    { text: 'Wrote the first note on computation.' },
  ]);
  // Second: "2018 - 2020" → startDate=2018, endDate=2020
  assert.equal(p.experience[1].startDate, '2018');
  assert.equal(p.experience[1].endDate,   '2020');
  // Third: unparseable period → no date fields at all
  assert.equal('startDate' in p.experience[2], false);
  assert.equal('endDate'   in p.experience[2], false);
});

test('projects: slug + name + tagline; empty titles dropped', () => {
  const p = mapCareerPacketToLivingCV(samplePacket());
  assert.equal(p.projects.length, 1);
  assert.equal(p.projects[0].name,    'First Algorithm!');
  assert.equal(p.projects[0].slug,    'first-algorithm');
  assert.equal(p.projects[0].tagline, 'Note G.');
});

test('skills: flattened {name, category}', () => {
  const p = mapCareerPacketToLivingCV(samplePacket());
  assert.deepEqual(p.skills, [
    { name: 'TypeScript', category: 'Languages' },
    { name: 'Calculus',   category: 'Math' },
  ]);
});

test('education: institution/degree/endDate', () => {
  const p = mapCareerPacketToLivingCV(samplePacket());
  assert.equal(p.education.length, 1);
  assert.equal(p.education[0].institution, 'University of London');
  assert.equal(p.education[0].degree,      'BA Mathematics');
  assert.equal(p.education[0].endDate,     '2017');
});

test('summary carried from basics.summary (no empty fallback)', () => {
  const p = mapCareerPacketToLivingCV(samplePacket());
  assert.equal(p.summary, 'Mathematician and writer; first programmer.');
  const empty = samplePacket();
  empty.basics.summary = '';
  assert.equal('summary' in mapCareerPacketToLivingCV(empty), false);
});

test('validateLivingCVShape: rejects missing fullName', () => {
  const p = mapCareerPacketToLivingCV(samplePacket());
  p.identity.fullName = '';
  assert.throws(() => validateLivingCVShape(p), /fullName/);
});

test('splitPeriod handles dashes (en, em, hyphen) and "to"', () => {
  assert.deepEqual(splitPeriod('May 2020 - Present'),     { startDate: '2020-05', endDate: undefined });
  assert.deepEqual(splitPeriod('May 2020 – Present'),     { startDate: '2020-05', endDate: undefined });
  assert.deepEqual(splitPeriod('May 2020 — Present'),     { startDate: '2020-05', endDate: undefined });
  assert.deepEqual(splitPeriod('May 2020 to Present'),    { startDate: '2020-05', endDate: undefined });
  assert.deepEqual(splitPeriod('2018 - 2020'),            { startDate: '2018',    endDate: '2020' });
  assert.deepEqual(splitPeriod(''),                       {});
  assert.deepEqual(splitPeriod('never parseable'),        {});
});
