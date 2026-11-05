/**
 * Rust Academy — a Client-only Harness plugin.
 *
 * Registers two things in the Web UI:
 *   - `sidebar.panellist` id `rust-academy`  → the icon in the left sidebar
 *   - `main` key `rust-academy`              → the page shown when it is selected
 *
 * The curriculum is injected at the `/*@DATA@*\/` marker by `build.mjs` from
 * `src/data/*.mjs`. Styles use only `--dsw-alias-*` theme tokens. Progress is
 * stored in localStorage.
 */
window.__ModuleLoader__.load({
  id: '@local/rust-academy',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;

    const NS = 'rust-academy';
    const PROGRESS_KEY = 'dsh.rust-academy.progress.v1';
    const LAST_KEY = 'dsh.rust-academy.last.v1';
    const QUIZ_KEY = 'dsh.rust-academy.quiz.v1';
    const NAV_KEY = 'dsh.rust-academy.nav.v1';
    const PLAYGROUND_KEY = 'dsh.rust-academy.playground.v1';
    const PLAYGROUND_URL = 'https://play.rust-lang.org/execute';
    const PLAYGROUND_CLIPPY = 'https://play.rust-lang.org/clippy';
    const PLAYGROUND_FORMAT = 'https://play.rust-lang.org/format';
    const PLAYGROUND_DEFAULT = 'fn main() {\n    println!("Hello from the Rust Playground!");\n}\n';
    let playgroundAbort = null;

    // ------------------------------------------------------------------ i18n

    const DICT = {
      'panel.title': 'Rust Academy',
      'panel.tagline': 'Production Rust — web, data, services, processes, platform',
      'panel.stats': '{tracks} tracks · {lessons} lessons',
      'tab.course': 'Course',
      'tab.blueprints': 'Blueprints',
      'tab.cheatsheet': 'Cheatsheet',
      'tab.playground': 'Playground',
      'playground.title': 'Rust Playground',
      'playground.privacy': 'Runs in the official play.rust-lang.org sandbox — code is sent there, needs network.',
      'playground.run': 'Run',
      'playground.running': 'Running in the sandbox…',
      'playground.lint': 'Clippy lint',
      'playground.runningLint': 'Linting…',
      'playground.format': 'Format',
      'playground.formatting': 'Formatting…',
      'playground.formatted': 'Formatted with rustfmt',
      'playground.diagnostics': 'Diagnostics',
      'playground.suggestions': 'Suggestions',
      'playground.insert': 'Insert at cursor',
      'playground.testSummary': '{passed} passed · {failed} failed',
      'playground.testsOk': 'Tests passed',
      'playground.testsFailed': 'Tests failed',
      'playground.clear': 'Clear',
      'playground.loadStarter': 'Load chapter starter',
      'playground.loadSolution': 'Load chapter solution',
      'playground.edition': 'Edition',
      'playground.tests': 'Run tests',
      'playground.stdout': 'stdout',
      'playground.stderr': 'stderr',
      'playground.success': 'Success',
      'playground.failure': 'Failed',
      'playground.networkError': 'Could not reach the Rust Playground. Check your connection or open play.rust-lang.org directly.',
      'playground.empty': 'Write code and press Run (or Ctrl/Cmd+Enter) to execute it in the sandbox.',
      'playground.hint': 'Ctrl/Cmd+Enter to run',
      'search.placeholder': 'Search lessons, crates, patterns…',
      'search.results': '{n} result(s)',
      'search.empty': 'No lessons match that search.',
      'progress.label': '{done} of {total} lessons',
      'action.markComplete': 'Mark complete',
      'action.completed': 'Completed',
      'action.reset': 'Reset',
      'action.confirmReset': 'Reset progress?',
      'action.copy': 'Copy',
      'action.copyPrompt': 'Copy tutor prompt',
      'action.askInChat': 'Ask in chat',
      'action.focus': 'Focus',
      'action.exitFocus': 'Exit focus',
      'action.showHint': 'Show hint',
      'action.hideHint': 'Hide hint',
      'action.showSolution': 'Show solution',
      'action.hideSolution': 'Hide solution',
      'lesson.of': 'Lesson {n} of {total}',
      'lesson.minutes': '{n} min',
      'lesson.goal': 'Goal',
      'lesson.production': 'In production',
      'lesson.crates': 'Crates',
      'lesson.pitfall': 'Pitfall',
      'lesson.resources': 'References',
      'lesson.prev': 'Previous',
      'lesson.next': 'Next',
      'lesson.trackProject': 'Track capstone',
      'project.deliverables': 'Deliverables',
      'project.stack': 'Stack',
      'level.core': 'Core',
      'level.advanced': 'Advanced',
      'level.industry': 'Industry',
      'exercise.title': 'Your turn',
      'exercise.starter': 'Starter',
      'exercise.solution': 'Solution',
      'cheatsheet.subtitle': 'Copy-ready syntax and configuration for production Rust services.',
      'blueprints.subtitle': 'Reference architectures: how the pieces fit together, and what to verify before shipping.',
      'bp.flow': 'Request / data flow',
      'bp.components': 'Components',
      'bp.checklist': 'Production checklist',
      'bp.lessons': 'Related lessons',
      'bp.resources': 'References',
      'track.done': '{done}/{total} done',
      'track.all': 'All tracks',
      'track.select': 'Jump to a track',
      'lesson.questions': 'Check yourself',
      'questions.score': '{correct}/{total} correct',
      'shortcut.prev': 'Previous chapter (←)',
      'shortcut.next': 'Next chapter (→)',
      'lesson.quickbytes': 'Quick bytes',
      'lesson.github': 'GitHub',
      'resource.docs': 'Docs',
      'resource.repo': 'Repo',
      'resource.paper': 'Paper',
      'resource.video': 'Video',
      'resource.article': 'Article',
      'toast.copied': 'Copied to clipboard',
      'toast.copyFailed': 'Clipboard unavailable',
      'toast.reset': 'Progress reset',
    };

    let localeService = null;
    let layoutService = null;
    let boundTranslate = null;

    function interpolate(text, vars) {
      if (!vars) return text;
      return String(text).replace(/\{(\w+)\}/g, (whole, key) => (
        vars[key] === undefined || vars[key] === null ? whole : String(vars[key])
      ));
    }

    function t(key, vars) {
      let text = null;
      if (boundTranslate) {
        try { text = boundTranslate(key); } catch (error) { text = null; }
      }
      if (text === null || text === undefined || text === key || text === '') {
        text = Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : key;
      }
      return interpolate(text, vars);
    }

    function useRevision() {
      const [revision, setRevision] = useState(0);
      useEffect(() => {
        if (!localeService) return undefined;
        let live = true;
        const off = localeService.subscribe(() => { if (live) setRevision((value) => value + 1); });
        return () => { live = false; off(); };
      }, []);
      return revision;
    }

    // --------------------------------------------------------------- storage

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
      } catch (error) {
        return fallback;
      }
    }

    function writeJson(key, value) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* best effort */ }
    }

    // ------------------------------------------------------------------ data

    /*@DATA@*/

    const LESSON_BY_ID = {};
    LESSONS.forEach((lesson) => { LESSON_BY_ID[lesson.id] = lesson; });

    // -------------------------------------------------------------- rendering

    const KW = new Set([
      'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else',
      'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop',
      'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static',
      'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
    ]);
    const TYPES = new Set([
      'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128',
      'usize', 'f32', 'f64', 'bool', 'char', 'str', 'String', 'Vec', 'Option', 'Result',
      'Box', 'Rc', 'Arc', 'RefCell', 'Mutex', 'RwLock', 'HashMap', 'HashSet', 'BTreeMap',
      'VecDeque', 'Duration', 'Instant', 'Path', 'PathBuf', 'Cow',
    ]);

    const TOKEN_RE = /(\/\/[^\n]*)|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])'?)|(\b\d[\d_]*(?:\.\d+)?(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_]+)/g;

    function highlightRust(code) {
      const nodes = [];
      let match;
      let index = 0;
      TOKEN_RE.lastIndex = 0;
      while ((match = TOKEN_RE.exec(code)) !== null) {
        index += 1;
        if (match[1]) {
          nodes.push(h('span', { key: index, className: 'ra-tok-com' }, match[1]));
        } else if (match[2] || match[3]) {
          nodes.push(h('span', { key: index, className: 'ra-tok-str' }, match[2] || match[3]));
        } else if (match[4]) {
          nodes.push(h('span', { key: index, className: 'ra-tok-num' }, match[4]));
        } else if (match[5]) {
          const word = match[5];
          if (KW.has(word)) nodes.push(h('span', { key: index, className: 'ra-tok-kw' }, word));
          else if (TYPES.has(word) || /^[A-Z]/.test(word)) nodes.push(h('span', { key: index, className: 'ra-tok-ty' }, word));
          else nodes.push(word);
        } else {
          nodes.push(match[6] || match[7] || '');
        }
      }
      return nodes;
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text);
        }
      } catch (error) { /* fall through */ }
      return Promise.reject(new Error('clipboard unavailable'));
    }

    function tutorPrompt(lesson) {
      const track = TRACKS[lesson.trackIndex] || TRACKS[0];
      const lines = [
        'You are my staff-level Rust mentor. I am on lesson ' + lesson.n + ' of ' + TOTAL +
          ': "' + lesson.title + '" (' + track.title + ').',
        'Goal: ' + lesson.goal,
        'The project is a Cargo workspace at rust-course/ (examples in src/bin/, notes in lessons/).',
      ];
      if (lesson.production && lesson.production.length) {
        lines.push('Production checklist for this topic: ' + lesson.production.join('; ') + '.');
      }
      if (lesson.pitfall) lines.push('Known pitfall to test me on: ' + lesson.pitfall);
      lines.push('Teach it interactively: 1) explain the key idea in five sentences, 2) give one snippet and ask me to predict its output, 3) give two exercises and wait for my answers. Do not reveal solutions until I have tried.');
      return lines.join('\n');
    }

    function matchesQuery(lesson, query) {
      const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return true;
      const haystack = [
        lesson.title, lesson.goal, lesson.trackTitle, lesson.id,
        (lesson.crates || []).join(' '),
        (lesson.production || []).join(' '),
        (lesson.quickbytes || []).join(' '),
        (lesson.questions || []).map((question) => question.q).join(' '),
      ].join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    }

    // ------------------------------------------------------------- primitives

    function CrabMark({ size = 24, filled = false }) {
      if (!filled) {
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          'aria-hidden': true, focusable: false, style: { display: 'block' },
        },
          h('ellipse', { cx: 12, cy: 14.5, rx: 6.4, ry: 4.4, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M9.4 11.4 L9 9.2 M14.6 11.4 L15 9.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('circle', { cx: 9, cy: 8.4, r: 1.7, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('circle', { cx: 15, cy: 8.4, r: 1.7, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M5.9 12.6 C4 11.6 3 9.6 4.2 8.2 c1.2-1.3 3.4-.6 3.4 1.1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('path', { d: 'M18.1 12.6 C20 11.6 21 9.6 19.8 8.2 c-1.2-1.3-3.4-.6-3.4 1.1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('path', { d: 'M7.6 18 L6 20.4 M10.6 19.2 L9.8 21.4 M16.4 18 L18 20.4 M13.4 19.2 L14.2 21.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })
        );
      }
      return h('svg', {
        width: size, height: size, viewBox: '0 0 64 64',
        'aria-hidden': true, focusable: false, style: { display: 'block' },
      },
        h('g', { fill: 'none', stroke: '#7a2a1b', strokeWidth: 3, strokeLinecap: 'round' },
          h('path', { d: 'M20 46 L12 54' }),
          h('path', { d: 'M27 49 L23 58' }),
          h('path', { d: 'M44 46 L52 54' }),
          h('path', { d: 'M37 49 L41 58' }),
          h('path', { d: 'M25 28 L24 24' }),
          h('path', { d: 'M39 28 L40 24' })
        ),
        h('g', { fill: '#ce422b', stroke: '#7a2a1b', strokeWidth: 3, strokeLinejoin: 'round' },
          h('path', { d: 'M15 30c-4-1-7-5-6-8 1-4 6-4 8-2 1 2 1 4 0 5 3 0 4 2 4 4z' }),
          h('path', { d: 'M49 30c4-1 7-5 6-8-1-4-6-4-8-2-1 2-1 4 0 5-3 0-4 2-4 4z' }),
          h('ellipse', { cx: 32, cy: 38, rx: 17, ry: 12 })
        ),
        h('circle', { cx: 24, cy: 21, r: 5.5, fill: '#ffffff', stroke: '#7a2a1b', strokeWidth: 3 }),
        h('circle', { cx: 40, cy: 21, r: 5.5, fill: '#ffffff', stroke: '#7a2a1b', strokeWidth: 3 }),
        h('circle', { cx: 24, cy: 22, r: 2.2, fill: '#2b1a16' }),
        h('circle', { cx: 40, cy: 22, r: 2.2, fill: '#2b1a16' }),
        h('path', { d: 'M28 38 q4 3 8 0', fill: 'none', stroke: '#7a2a1b', strokeWidth: 3, strokeLinecap: 'round' })
      );
    }

    function CodeBlock({ code, lang, caption, onCopy }) {
      return h('div', { className: 'ra-codeblock' },
        h('div', { className: 'ra-codeblock-bar' },
          h('span', { className: 'ra-codeblock-lang' }, caption || lang || 'rust'),
          h('button', { type: 'button', className: 'ra-ghost ra-copy', onClick: () => onCopy(code), title: t('action.copy') }, t('action.copy'))
        ),
        h('pre', { className: 'ra-pre' }, h('code', null, lang === 'rust' ? highlightRust(code) : code))
      );
    }

    function LevelChip({ level }) {
      const value = level || 'core';
      return h('span', { className: 'ra-chip ra-level ra-level-' + value }, t('level.' + value));
    }

    function ExternalLink({ url, children }) {
      return h('a', { className: 'ra-link', href: url, target: '_blank', rel: 'noreferrer noopener' },
        children, h('span', { className: 'ra-link-mark' }, '↗'));
    }

    function resourceKindLabel(kind) {
      return t('resource.' + (kind || 'docs'));
    }

    function ResourceList({ resources, title }) {
      if (!resources || resources.length === 0) return null;
      return h('section', { className: 'ra-refs' },
        h('h3', null, title || t('lesson.resources')),
        h('ul', null, resources.map((resource, index) => h('li', { key: index },
          h('span', { className: 'ra-kind ra-kind-' + (resource.kind || 'docs') }, resourceKindLabel(resource.kind)),
          h(ExternalLink, { url: resource.url }, resource.title))))
      );
    }

    function ProductionList({ items }) {
      if (!items || items.length === 0) return null;
      return h('section', { className: 'ra-production' },
        h('h3', null, t('lesson.production')),
        h('ul', null, items.map((item, index) => h('li', { key: index },
          h('span', { className: 'ra-check' }, '✓'), h('span', null, item))))
      );
    }

    function Crates({ crates }) {
      if (!crates || crates.length === 0) return null;
      return h('div', { className: 'ra-crates' },
        h('span', { className: 'ra-crates-label' }, t('lesson.crates')),
        crates.map((name) => h('a', {
          className: 'ra-crate',
          key: name,
          href: 'https://docs.rs/' + encodeURIComponent(name) + '/latest/' + encodeURIComponent(name) + '/',
          target: '_blank',
          rel: 'noreferrer noopener',
        }, name))
      );
    }

    function GithubLinks({ repos }) {
      if (!repos || repos.length === 0) return null;
      return h('div', { className: 'ra-github' },
        h('span', { className: 'ra-github-label' }, t('lesson.github')),
        repos.map((repo) => h(ExternalLink, { key: repo.url, url: repo.url }, repo.name))
      );
    }

    function Questions({ lessonId, questions }) {
      const [picked, setPicked] = useState(() => {
        const all = readJson(QUIZ_KEY, {});
        const saved = all && all[lessonId];
        return saved && typeof saved === 'object' ? saved : {};
      });
      const answered = Object.keys(picked).length;
      const correct = questions.reduce((total, question, index) => (
        picked[index] === question.answer ? total + 1 : total
      ), 0);

      function choose(questionIndex, optionIndex) {
        setPicked((current) => {
          const next = Object.assign({}, current, { [questionIndex]: optionIndex });
          const all = readJson(QUIZ_KEY, {});
          all[lessonId] = next;
          writeJson(QUIZ_KEY, all);
          return next;
        });
      }

      return h('section', { className: 'ra-questions' },
        h('div', { className: 'ra-questions-head' },
          h('h3', null, t('lesson.questions')),
          answered > 0
            ? h('span', { className: 'ra-quiz-score' },
                t('questions.score', { correct, total: questions.length }))
            : null
        ),
        questions.map((question, index) => {
          const choice = picked[index];
          const isAnswered = choice !== undefined;
          return h('div', { className: 'ra-question', key: index },
            h('p', { className: 'ra-question-q' }, (index + 1) + '. ' + question.q),
            h('div', { className: 'ra-options' }, question.options.map((option, optionIndex) => {
              const selected = choice === optionIndex;
              const isCorrect = optionIndex === question.answer;
              let className = 'ra-option';
              if (isAnswered && selected) className += ' is-selected ' + (isCorrect ? 'is-correct' : 'is-wrong');
              else if (isAnswered && isCorrect) className += ' is-selected is-correct';
              return h('button', {
                type: 'button',
                key: optionIndex,
                className,
                disabled: isAnswered,
                onClick: () => choose(index, optionIndex),
              }, option);
            })),
            isAnswered
              ? h('p', { className: 'ra-question-explain' },
                  (choice === question.answer ? '✓ ' : '✕ ') + question.explain)
              : null
          );
        })
      );
    }

    function Quickbytes({ items }) {
      return h('section', { className: 'ra-quickbytes' },
        h('h3', null, t('lesson.quickbytes')),
        items.map((item, index) => h('div', { className: 'ra-quickbyte', key: index },
          h('span', { className: 'ra-check' }, '›'), h('span', null, item)))
      );
    }

    function TrackProject({ project }) {
      if (!project) return null;
      return h('section', { className: 'ra-track-project' },
        h('div', { className: 'ra-track-project-head' },
          h('span', { className: 'ra-badge' }, t('lesson.trackProject')),
          h('h3', null, project.title)
        ),
        h('p', null, project.brief),
        h('div', { className: 'ra-track-project-cols' },
          h('div', null,
            h('h4', null, t('project.deliverables')),
            h('ul', null, (project.deliverables || []).map((item, index) => h('li', { key: index }, item)))
          ),
          h('div', null,
            h('h4', null, t('project.stack')),
            h('div', { className: 'ra-crates' }, (project.stack || []).map((name) => h('span', { className: 'ra-crate', key: name }, name)))
          )
        )
      );
    }

    function TabButton({ active, children, onClick }) {
      return h('button', { type: 'button', className: 'ra-tab' + (active ? ' is-active' : ''), onClick, 'aria-pressed': active }, children);
    }

    function lessonRow(lesson, selectedId, done, onSelect, showTrack, autoScroll) {
      const ref = autoScroll && lesson.id === selectedId
        ? (node) => { if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' }); }
        : undefined;
      return h('button', {
        type: 'button',
        key: lesson.id,
        ref,
        className: 'ra-lesson' + (lesson.id === selectedId ? ' is-active' : '') + (done[lesson.id] ? ' is-done' : ''),
        onClick: () => onSelect(lesson.id),
        'aria-current': lesson.id === selectedId ? 'page' : undefined,
      },
        h('span', { className: 'ra-lesson-num' }, done[lesson.id] ? '✓' : String(lesson.n)),
        h('span', { className: 'ra-lesson-title' }, lesson.title),
        showTrack ? h('span', { className: 'ra-lesson-track' }, lesson.trackTitle) : null,
        h('span', { className: 'ra-lesson-min' }, t('lesson.minutes', { n: lesson.minutes }))
      );
    }

    function LessonNav({ selectedId, done, query, trackFilter, openTracks, onToggleTrack, onSelect }) {
      const searching = String(query || '').trim().length > 0;
      if (searching) {
        const results = LESSONS.filter((lesson) => matchesQuery(lesson, query));
        return h('nav', { className: 'ra-nav', 'aria-label': t('panel.title') },
          h('div', { className: 'ra-nav-label' }, t('search.results', { n: results.length })),
          results.length === 0
            ? h('div', { className: 'ra-empty' }, t('search.empty'))
            : results.map((lesson) => lessonRow(lesson, selectedId, done, onSelect, true, false))
        );
      }
      const activeTracks = trackFilter && trackFilter !== 'all'
        ? TRACKS.filter((track) => track.key === trackFilter)
        : TRACKS;
      return h('nav', { className: 'ra-nav', 'aria-label': t('panel.title') },
        activeTracks.map((track) => {
          const trackLessons = LESSONS.filter((lesson) => lesson.trackIndex === track.index);
          const completed = trackLessons.filter((lesson) => done[lesson.id]).length;
          const percent = trackLessons.length ? Math.round((completed / trackLessons.length) * 100) : 0;
          const open = !!openTracks[track.key];
          return h('div', { className: 'ra-stage' + (open ? ' is-open' : ''), key: track.key },
            h('button', {
              type: 'button',
              className: 'ra-stage-head',
              onClick: () => onToggleTrack(track.key),
              'aria-expanded': open,
            },
              h('span', { className: 'ra-stage-chevron' }, open ? '▾' : '▸'),
              h('span', { className: 'ra-track-title' }, track.title),
              h('span', { className: 'ra-track-level' }, h(LevelChip, { level: track.level })),
              h('span', { className: 'ra-stage-count' }, t('track.done', { done: completed, total: trackLessons.length }))
            ),
            h('div', { className: 'ra-stage-progress' },
              h('div', { className: 'ra-stage-progress-fill', style: { width: percent + '%' } })
            ),
            open
              ? h('div', { className: 'ra-stage-lessons' },
                  trackLessons.map((lesson) => lessonRow(lesson, selectedId, done, onSelect, false, true)))
              : null
          );
        })
      );
    }

    function Article({ lesson, done, onToggleDone, onCopy, onPrev, onNext, prev, next }) {
      const [hintOpen, setHintOpen] = useState(false);
      const [solutionOpen, setSolutionOpen] = useState(false);

      useEffect(() => {
        setHintOpen(false);
        setSolutionOpen(false);
      }, [lesson.id]);

      const exercise = lesson.exercise;
      const track = TRACKS[lesson.trackIndex] || TRACKS[0];
      const atTrackEnd = lesson.n === track.lastN;

      return h('article', { className: 'ra-article' },
        h('div', { className: 'ra-article-inner' },
          h('div', { className: 'ra-crumbs' },
            track.title + ' · ' + t('lesson.of', { n: lesson.n, total: TOTAL })),
          h('div', { className: 'ra-lesson-head' },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('h1', null, lesson.title),
              h('div', { className: 'ra-lesson-meta' },
                h(LevelChip, { level: lesson.level }),
                h('span', { className: 'ra-chip' }, t('lesson.minutes', { n: lesson.minutes })),
                h('span', { className: 'ra-chip' }, track.title)
              )
            ),
            h('button', {
              type: 'button',
              className: 'ra-ghost ra-complete' + (done ? ' is-done' : ''),
              onClick: onToggleDone,
              'aria-pressed': !!done,
            }, done ? '✓ ' + t('action.completed') : t('action.markComplete'))
          ),
          h('div', { className: 'ra-goal' },
            h('b', null, t('lesson.goal')),
            lesson.goal
          ),
          lesson.sections.map((section, index) => h('section', { className: 'ra-section', key: index },
            h('h2', null, section.h),
            section.p.map((paragraph, pIndex) => h('p', { key: pIndex }, paragraph)),
            section.list ? h('ul', null, section.list.map((item, lIndex) => h('li', { key: lIndex }, item))) : null,
            section.code ? h(CodeBlock, { code: section.code, lang: 'rust', onCopy }) : null,
            section.tip ? h('div', { className: 'ra-tip' },
              h('span', { className: 'ra-tip-mark' }, '!'), h('span', null, section.tip)) : null
          )),
          h('section', { className: 'ra-exercise' },
            h('div', { className: 'ra-exercise-head' }, h('span', { className: 'ra-badge' }, t('exercise.title'))),
            h('p', { className: 'ra-exercise-prompt' }, exercise.prompt),
            h(CodeBlock, { code: exercise.starter, lang: 'rust', caption: t('exercise.starter'), onCopy }),
            h('div', { className: 'ra-exercise-actions' },
              h('button', {
                type: 'button', className: 'ra-ghost',
                onClick: () => setHintOpen((value) => !value), 'aria-expanded': hintOpen,
              }, hintOpen ? t('action.hideHint') : t('action.showHint')),
              h('button', {
                type: 'button', className: 'ra-ghost',
                onClick: () => setSolutionOpen((value) => !value), 'aria-expanded': solutionOpen,
              }, solutionOpen ? t('action.hideSolution') : t('action.showSolution')),
              h('button', { type: 'button', className: 'ra-ghost', onClick: () => onCopy(tutorPrompt(lesson)) }, t('action.copyPrompt'))
            ),
            hintOpen ? h('p', { className: 'ra-hint' }, exercise.hint) : null,
            solutionOpen ? h(CodeBlock, { code: exercise.solution, lang: 'rust', caption: t('exercise.solution'), onCopy }) : null
          ),
          lesson.questions && lesson.questions.length
            ? h(Questions, { key: lesson.id, lessonId: lesson.id, questions: lesson.questions })
            : null,
          lesson.quickbytes && lesson.quickbytes.length
            ? h(Quickbytes, { items: lesson.quickbytes })
            : null,
          lesson.pitfall ? h('div', { className: 'ra-pitfall' },
            h('b', null, t('lesson.pitfall')), h('span', null, lesson.pitfall)) : null,
          h(ProductionList, { items: lesson.production }),
          h(Crates, { crates: lesson.crates }),
          h(GithubLinks, { repos: lesson.github }),
          h(ResourceList, { resources: lesson.resources }),
          atTrackEnd ? h(TrackProject, { project: track.project }) : null,
          h('div', { className: 'ra-lesson-foot' },
            prev ? h('button', { type: 'button', className: 'ra-ghost', title: t('shortcut.prev'), onClick: () => onPrev(prev.id) }, '← ' + t('lesson.prev')) : null,
            h('span', { className: 'ra-spacer' }),
            next ? h('button', { type: 'button', className: 'ra-primary', title: t('shortcut.next'), onClick: () => onNext(next.id) }, t('lesson.next') + ' →') : null
          )
        )
      );
    }

    function BlueprintCard({ blueprint, onOpenLesson }) {
      return h('article', { className: 'ra-bp' },
        h('div', { className: 'ra-bp-head' },
          h('h3', null, blueprint.title),
          h(LevelChip, { level: blueprint.level || 'industry' })
        ),
        h('p', { className: 'ra-bp-summary' }, blueprint.summary),
        h('div', { className: 'ra-crates' }, (blueprint.stack || []).map((name) => h('span', { className: 'ra-crate', key: name }, name))),
        h('div', { className: 'ra-bp-block' },
          h('h4', null, t('bp.flow')),
          h('ol', null, (blueprint.flow || []).map((step, index) => h('li', { key: index }, step)))
        ),
        blueprint.components && blueprint.components.length
          ? h('div', { className: 'ra-bp-block' },
              h('h4', null, t('bp.components')),
              blueprint.components.map((component) => h('div', { className: 'ra-bp-component', key: component.name },
                h('b', null, component.name),
                h('span', { className: 'ra-bp-role' }, component.role),
                (component.crates || []).map((name) => h('span', { className: 'ra-crate', key: name }, name))
              ))
            )
          : null,
        h('div', { className: 'ra-bp-block' },
          h('h4', null, t('bp.checklist')),
          h('ul', { className: 'ra-bp-checklist' }, (blueprint.checklist || []).map((item, index) => h('li', { key: index }, item)))
        ),
        (blueprint.lessons || []).length
          ? h('div', { className: 'ra-bp-block' },
              h('h4', null, t('bp.lessons')),
              h('div', { className: 'ra-bp-lessons' }, blueprint.lessons.map((id) => {
                const lesson = LESSON_BY_ID[id];
                return lesson
                  ? h('button', { key: id, type: 'button', className: 'ra-ghost', onClick: () => onOpenLesson(id) },
                      lesson.n + '. ' + lesson.title)
                  : null;
              }))
            )
          : null,
        h(ResourceList, { resources: blueprint.resources, title: t('bp.resources') })
      );
    }

    function Blueprints({ onOpenLesson }) {
      return h('div', { className: 'ra-page' },
        h('div', { className: 'ra-page-inner' },
          h('div', { className: 'ra-page-head' },
            h('h1', null, t('tab.blueprints')),
            h('p', null, t('blueprints.subtitle'))
          ),
          h('div', { className: 'ra-bp-grid' },
            BLUEPRINTS.map((blueprint) => h(BlueprintCard, { key: blueprint.id, blueprint, onOpenLesson })))
        )
      );
    }

    function CheatItem({ item, onCopy }) {
      return h('div', { className: 'ra-cheat-item' },
        h('div', { className: 'ra-cheat-name-row' },
          h('span', { className: 'ra-cheat-name' }, item.name),
          h('button', { type: 'button', className: 'ra-ghost ra-cheat-copy', onClick: () => onCopy(item.code) }, t('action.copy'))
        ),
        h('pre', { className: 'ra-cheat-code' }, highlightRust(item.code))
      );
    }

    function Cheatsheet({ onCopy }) {
      return h('div', { className: 'ra-page' },
        h('div', { className: 'ra-page-inner' },
          h('div', { className: 'ra-page-head' },
            h('h1', null, t('tab.cheatsheet')),
            h('p', null, t('cheatsheet.subtitle'))
          ),
          h('div', { className: 'ra-cheat-grid' },
            CHEATSHEET.map((group) => h('section', { className: 'ra-cheat-group', key: group.title },
              h('h2', null, group.title),
              group.items.map((item) => h(CheatItem, { key: item.name, item, onCopy }))
            ))
          )
        )
      );
    }

    function parseDiagnostics(stderr) {
      const lines = String(stderr || '').split('\n');
      const items = [];
      let current = null;
      for (const line of lines) {
        const header = line.match(/^(error|warning)(?:\[([A-Z]\d+)\])?:\s*(.*)$/);
        if (header) {
          current = { severity: header[1], code: header[2] || '', message: header[3], location: '', helps: [] };
          items.push(current);
          continue;
        }
        if (!current) continue;
        const location = line.match(/^\s*-->\s*(\S+:\d+:\d+)/);
        if (location) { current.location = location[1]; continue; }
        const help = line.match(/^\s*(?:=\s*)?help:\s*(.*)$/);
        if (help) { current.helps.push(help[1]); continue; }
        const note = line.match(/^\s*=\s*note:\s*(.*)$/);
        if (note) { current.helps.push('note: ' + note[1]); continue; }
      }
      return items;
    }

    function parseTestSummary(stdout) {
      const match = String(stdout || '').match(/test result:\s*(ok|FAILED)\.\s*(\d+) passed;\s*(\d+) failed/);
      if (!match) return null;
      return { ok: match[1] === 'ok', passed: Number(match[2]), failed: Number(match[3]) };
    }

    const PLAYGROUND_SNIPPETS = [
      'fn main() {}', 'let mut ', 'println!()', 'format!()', 'match ', 'if let ',
      'impl ', 'struct ', 'enum ', 'trait ', '#[derive(Debug)]', 'Vec<',
      'Option<', 'Result<', 'String', 'HashMap', '.iter()', '.collect()',
      '.unwrap_or()', '?', 'async fn ', '.await', 'assert_eq!()',
    ];

    function Playground({ lesson }) {
      const saved = readJson(PLAYGROUND_KEY, {});
      const [code, setCode] = useState(() => typeof saved.code === 'string' ? saved.code : PLAYGROUND_DEFAULT);
      const [edition, setEdition] = useState(typeof saved.edition === 'string' ? saved.edition : '2021');
      const [tests, setTests] = useState(!!saved.tests);
      const [running, setRunning] = useState(false);
      const [kind, setKind] = useState('run');
      const [result, setResult] = useState(null);
      const [diagnostics, setDiagnostics] = useState([]);
      const [testSummary, setTestSummary] = useState(null);
      const [notice, setNotice] = useState('');
      const [error, setError] = useState('');
      const [elapsed, setElapsed] = useState(0);
      const [selection, setSelection] = useState({ start: 0, end: 0 });

      useEffect(() => {
        writeJson(PLAYGROUND_KEY, { code, edition, tests });
      }, [code, edition, tests]);

      useEffect(() => () => {
        if (playgroundAbort) playgroundAbort.abort();
      }, []);

      const suggestions = PLAYGROUND_SNIPPETS.concat(
        lesson && lesson.crates ? lesson.crates.map((name) => name + '::') : []
      );

      function finish(payload) {
        const value = payload && typeof payload === 'object' ? payload : { success: false, stdout: '', stderr: 'Unexpected response' };
        setResult(value);
        setDiagnostics(parseDiagnostics(value.stderr));
        setTestSummary(parseTestSummary(value.stdout));
        setRunning(false);
      }

      function fail(err) {
        if (err && err.name === 'AbortError') { setRunning(false); return; }
        setError(t('playground.networkError'));
        setRunning(false);
      }

      function execute(nextKind) {
        if (running) return;
        const controller = new AbortController();
        playgroundAbort = controller;
        const started = Date.now();
        setRunning(true);
        setKind(nextKind);
        setError('');
        setNotice('');
        setResult(null);
        setDiagnostics([]);
        setTestSummary(null);
        const body = {
          channel: 'stable',
          mode: 'debug',
          edition,
          crateType: 'bin',
          tests: nextKind === 'run' ? tests : false,
          code,
        };
        const url = nextKind === 'lint' ? PLAYGROUND_CLIPPY : PLAYGROUND_EXECUTE;
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => { setElapsed(Date.now() - started); finish(payload); })
          .catch(fail);
      }

      function formatCode() {
        if (running) return;
        const controller = new AbortController();
        playgroundAbort = controller;
        setRunning(true);
        setKind('format');
        setError('');
        setNotice('');
        setResult(null);
        setDiagnostics([]);
        setTestSummary(null);
        fetch(PLAYGROUND_FORMAT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, edition }),
          signal: controller.signal,
        })
          .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then((payload) => {
            if (payload && typeof payload.code === 'string') {
              setCode(payload.code);
              setNotice(t('playground.formatted'));
              setRunning(false);
            } else {
              finish(payload);
            }
          })
          .catch(fail);
      }

      function loadExercise(part) {
        if (!lesson || !lesson.exercise) return;
        setCode(lesson.exercise[part] || '');
        setNotice('');
      }

      function insertSnippet(text) {
        const start = typeof selection.start === 'number' ? selection.start : code.length;
        const end = typeof selection.end === 'number' ? selection.end : code.length;
        setCode(code.slice(0, start) + text + code.slice(end));
        setNotice('');
      }

      const failed = result ? result.success === false : false;
      const statusLabel = kind === 'lint' ? t('playground.lint') : kind === 'format' ? t('playground.format') : t('playground.run');
      const runningLabel = kind === 'lint' ? t('playground.runningLint')
        : kind === 'format' ? t('playground.formatting') : t('playground.running');

      return h('div', { className: 'ra-play' },
        h('div', { className: 'ra-play-toolbar' },
          h('div', { className: 'ra-play-heading' },
            h('span', { className: 'ra-play-title' }, t('playground.title')),
            h('span', { className: 'ra-play-note' }, t('playground.privacy'))
          ),
          h('div', { className: 'ra-play-controls' },
            h('label', { className: 'ra-play-field' }, t('playground.edition'),
              h('select', {
                className: 'ra-select', value: edition, 'aria-label': t('playground.edition'),
                onChange: (event) => setEdition(event.target.value),
              }, ['2015', '2018', '2021', '2024'].map((value) => h('option', { key: value, value }, value)))
            ),
            h('label', { className: 'ra-play-check' },
              h('input', { type: 'checkbox', checked: tests, onChange: (event) => setTests(event.target.checked) }),
              t('playground.tests')
            ),
            h('button', {
              type: 'button', className: 'ra-primary', disabled: running,
              title: t('playground.hint'), onClick: () => execute('run'),
            }, running && kind === 'run' ? t('playground.running') : t('playground.run')),
            h('button', {
              type: 'button', className: 'ra-ghost', disabled: running, onClick: () => execute('lint'),
            }, running && kind === 'lint' ? t('playground.runningLint') : t('playground.lint')),
            h('button', {
              type: 'button', className: 'ra-ghost', disabled: running, onClick: formatCode,
            }, running && kind === 'format' ? t('playground.formatting') : t('playground.format')),
            h('button', {
              type: 'button', className: 'ra-ghost', disabled: !lesson || !lesson.exercise,
              onClick: () => loadExercise('starter'),
            }, t('playground.loadStarter')),
            h('button', {
              type: 'button', className: 'ra-ghost', disabled: !lesson || !lesson.exercise,
              onClick: () => loadExercise('solution'),
            }, t('playground.loadSolution')),
            h('button', { type: 'button', className: 'ra-ghost', onClick: () => { setCode(''); setNotice(''); } }, t('playground.clear'))
          ),
          h('div', { className: 'ra-play-suggestions' },
            h('span', { className: 'ra-play-suggestions-label' }, t('playground.suggestions')),
            suggestions.map((snippet) => h('button', {
              key: snippet, type: 'button', className: 'ra-chip ra-chip-button',
              title: t('playground.insert'), onClick: () => insertSnippet(snippet),
            }, snippet))
          )
        ),
        h('div', { className: 'ra-play-body' },
          h('div', { className: 'ra-play-editor' },
            h('textarea', {
              className: 'ra-play-code',
              value: code,
              spellCheck: false,
              'aria-label': t('playground.title'),
              onChange: (event) => { setCode(event.target.value); setNotice(''); },
              onSelect: (event) => setSelection({ start: event.target.selectionStart, end: event.target.selectionEnd }),
              onKeyDown: (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  execute('run');
                }
              },
            })
          ),
          h('div', { className: 'ra-play-output' },
            error ? h('div', { className: 'ra-play-error' }, error) : null,
            notice ? h('div', { className: 'ra-play-notice' }, notice) : null,
            result
              ? h('div', { className: 'ra-play-result' },
                  h('div', { className: 'ra-play-status' },
                    h('span', { className: 'ra-badge ' + (failed ? 'ra-badge-bad' : 'ra-badge-ok') },
                      failed ? t('playground.failure') : t('playground.success')),
                    h('span', { className: 'ra-play-meta' },
                      statusLabel + ' · ' + (result.exitDetail || result.exit_detail || '') + (elapsed ? ' · ' + elapsed + ' ms' : ''))
                  ),
                  testSummary
                    ? h('div', { className: 'ra-play-tests ' + (testSummary.ok ? 'is-ok' : 'is-bad') },
                        (testSummary.ok ? t('playground.testsOk') : t('playground.testsFailed')) +
                        ' · ' + t('playground.testSummary', { passed: testSummary.passed, failed: testSummary.failed }))
                    : null,
                  diagnostics.length
                    ? h('div', { className: 'ra-play-section' },
                        h('h4', null, t('playground.diagnostics')),
                        h('ul', { className: 'ra-play-diagnostics' },
                          diagnostics.slice(0, 12).map((item, index) => h('li', { key: index, className: 'ra-diag ra-diag-' + item.severity },
                            h('div', { className: 'ra-diag-head' },
                              h('span', { className: 'ra-diag-sev' }, item.severity + (item.code ? ' [' + item.code + ']' : '')),
                              h('span', { className: 'ra-diag-msg' }, item.message)
                            ),
                            item.location ? h('div', { className: 'ra-diag-loc' }, item.location) : null,
                            item.helps.length
                              ? h('ul', { className: 'ra-diag-helps' },
                                  item.helps.map((help, helpIndex) => h('li', { key: helpIndex }, help)))
                              : null
                          ))
                        )
                      )
                    : null,
                  h('div', { className: 'ra-play-section' },
                    h('h4', null, t('playground.stdout')),
                    h('pre', { className: 'ra-play-pre' }, result.stdout || '')
                  ),
                  result.stderr
                    ? h('div', { className: 'ra-play-section' },
                        h('h4', null, t('playground.stderr')),
                        h('pre', { className: 'ra-play-pre ra-play-stderr' }, result.stderr))
                    : null
                )
              : h('div', { className: 'ra-play-empty' }, running ? runningLabel : t('playground.empty'))
          )
        )
      );
    }
    function Panel() {
      useRevision();

      const [tab, setTab] = useState('course');
      const [query, setQuery] = useState('');
      const [selectedId, setSelectedId] = useState(() => {
        const last = readJson(LAST_KEY, null);
        return last && last.id && LESSON_BY_ID[last.id] ? last.id : LESSONS[0].id;
      });
      const [done, setDone] = useState(() => readJson(PROGRESS_KEY, {}));
      const [toast, setToast] = useState('');
      const [confirmReset, setConfirmReset] = useState(false);
      const [focus, setFocus] = useState(false);
      const [trackFilter, setTrackFilter] = useState('all');
      const [openTracks, setOpenTracks] = useState(() => readJson(NAV_KEY, {}));

      useEffect(() => {
        if (!toast) return undefined;
        const id = setTimeout(() => setToast(''), 2000);
        return () => clearTimeout(id);
      }, [toast]);

      const lesson = LESSON_BY_ID[selectedId] || LESSONS[0];
      const doneCount = LESSONS.filter((item) => done[item.id]).length;
      const percent = TOTAL === 0 ? 0 : Math.round((doneCount / TOTAL) * 100);
      const previous = lesson.n > 1 ? LESSONS[lesson.n - 2] : null;
      const following = lesson.n < TOTAL ? LESSONS[lesson.n] : null;

      useEffect(() => {
        if (tab !== 'course') return undefined;
        function onKeyDown(event) {
          const target = event.target;
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
          if (event.key === 'ArrowRight' && following) {
            event.preventDefault();
            selectLesson(following.id);
          } else if (event.key === 'ArrowLeft' && previous) {
            event.preventDefault();
            selectLesson(previous.id);
          }
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [tab, lesson.id]);

      useEffect(() => {
        const key = lesson.trackKey;
        setOpenTracks((current) => {
          if (current[key]) return current;
          const next = Object.assign({}, current, { [key]: true });
          writeJson(NAV_KEY, next);
          return next;
        });
      }, [lesson.id]);

      function flash(message) { setToast(message); }

      function copy(text) {
        copyText(text).then(
          () => flash(t('toast.copied')),
          () => flash(t('toast.copyFailed'))
        );
      }

      function selectLesson(id) {
        setSelectedId(id);
        writeJson(LAST_KEY, { id });
      }

      function toggleTrack(key) {
        setOpenTracks((current) => {
          const next = Object.assign({}, current);
          if (next[key]) delete next[key];
          else next[key] = true;
          writeJson(NAV_KEY, next);
          return next;
        });
      }

      function openLesson(id) {
        setTab('course');
        selectLesson(id);
      }

      function toggleDone() {
        setDone((current) => {
          const next = Object.assign({}, current);
          if (next[lesson.id]) delete next[lesson.id];
          else next[lesson.id] = true;
          writeJson(PROGRESS_KEY, next);
          return next;
        });
      }

      function resetProgress() {
        if (!confirmReset) { setConfirmReset(true); return; }
        setDone({});
        writeJson(PROGRESS_KEY, {});
        setConfirmReset(false);
        flash(t('toast.reset'));
      }

      function askInChat() {
        copy(tutorPrompt(lesson));
        if (layoutService && typeof layoutService.selectPanel === 'function') {
          layoutService.selectPanel('conversation');
        }
      }

      return h('div', { className: 'ra-root' },
        h('style', null, CSS),
        h('header', { className: 'ra-header' },
          h('div', { className: 'ra-brand' },
            h(CrabMark, { size: 30, filled: true }),
            h('div', null,
              h('div', { className: 'ra-title' }, t('panel.title')),
              h('div', { className: 'ra-sub' }, t('panel.stats', { tracks: TRACKS.length, lessons: TOTAL }))
            )
          ),
          h('div', { className: 'ra-header-spacer' }),
          h('div', { className: 'ra-progress' },
            h('div', { className: 'ra-progress-label' }, t('progress.label', { done: doneCount, total: TOTAL })),
            h('div', {
              className: 'ra-progress-track', role: 'progressbar',
              'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100,
            }, h('div', { className: 'ra-progress-fill', style: { width: percent + '%' } }))
          )
        ),
        h('div', { className: 'ra-tabs' },
          h(TabButton, { active: tab === 'course', onClick: () => setTab('course') }, t('tab.course')),
          h(TabButton, { active: tab === 'blueprints', onClick: () => setTab('blueprints') }, t('tab.blueprints')),
          h(TabButton, { active: tab === 'cheatsheet', onClick: () => setTab('cheatsheet') }, t('tab.cheatsheet')),
          h(TabButton, { active: tab === 'playground', onClick: () => setTab('playground') }, t('tab.playground')),
          h('div', { className: 'ra-tabs-spacer' }),
          tab === 'course'
            ? h('div', { className: 'ra-tools' },
                h('select', {
                  className: 'ra-select',
                  value: trackFilter,
                  'aria-label': t('track.select'),
                  onChange: (event) => {
                    const value = event.target.value;
                    setTrackFilter(value);
                    if (value !== 'all') {
                      setOpenTracks((current) => {
                        const next = Object.assign({}, current, { [value]: true });
                        writeJson(NAV_KEY, next);
                        return next;
                      });
                      const first = LESSONS.find((item) => item.trackKey === value);
                      if (first) selectLesson(first.id);
                    }
                  },
                },
                  h('option', { value: 'all' }, t('track.all')),
                  TRACKS.map((track) => h('option', { key: track.key, value: track.key },
                    track.title + ' · ' + track.lessonCount))
                ),
                h('input', {
                  className: 'ra-search', type: 'search', value: query,
                  placeholder: t('search.placeholder'), 'aria-label': t('search.placeholder'),
                  onChange: (event) => setQuery(event.target.value),
                })
              )
            : null,
          tab === 'course' && doneCount > 0
            ? h('button', { type: 'button', className: 'ra-ghost', onClick: resetProgress },
                confirmReset ? t('action.confirmReset') : t('action.reset'))
            : null,
          tab === 'course'
            ? h('button', {
                type: 'button',
                className: 'ra-ghost',
                onClick: () => setFocus((value) => !value),
                'aria-pressed': focus,
              }, focus ? t('action.exitFocus') : t('action.focus'))
            : null,
          h('button', { type: 'button', className: 'ra-primary', onClick: askInChat }, t('action.askInChat'))
        ),
        tab === 'course'
          ? h('div', { className: 'ra-body' + (focus ? ' is-focus' : '') },
              h(LessonNav, { selectedId, done, query, trackFilter, openTracks, onToggleTrack: toggleTrack, onSelect: selectLesson }),
              h(Article, {
                key: lesson.id,
                lesson,
                done: !!done[lesson.id],
                onToggleDone: toggleDone,
                onCopy: copy,
                onPrev: selectLesson,
                onNext: selectLesson,
                prev: previous,
                next: following,
              })
            )
          : tab === 'blueprints'
            ? h(Blueprints, { onOpenLesson: openLesson })
            : tab === 'cheatsheet'
              ? h(Cheatsheet, { onCopy: copy })
              : h(Playground, { lesson }),
        toast ? h('div', { className: 'ra-toast', role: 'status' }, toast) : null
      );
    }

    function SidebarIcon({ size = 20, active = false }) {
      return h('span', {
        className: 'ra-sidebar-icon',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          opacity: active ? 1 : 0.92,
        },
      }, h(CrabMark, { size }));
    }

    const CSS = `
.ra-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}
.ra-header{display:flex;align-items:center;gap:12px;padding:16px 20px 12px;}
.ra-brand{display:flex;align-items:center;gap:11px;min-width:0;}
.ra-title{font-size:16px;font-weight:650;letter-spacing:-.01em;line-height:1.2;}
.ra-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.3;margin-top:2px;}
.ra-header-spacer{flex:1 1 auto;}
.ra-progress{display:flex;flex-direction:column;gap:5px;align-items:flex-end;min-width:132px;}
.ra-progress-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.ra-progress-track{width:132px;height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}
.ra-progress-fill{height:100%;background:var(--dsw-alias-brand-primary);border-radius:999px;transition:width .25s ease;}
.ra-tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 16px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.ra-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;padding:6px 11px;border-radius:8px;cursor:pointer;}
.ra-tab:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
.ra-tab.is-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}
.ra-tab:focus-visible,.ra-lesson:focus-visible,.ra-ghost:focus-visible,.ra-primary:focus-visible,.ra-search:focus-visible,.ra-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.ra-tabs-spacer{flex:1 1 auto;}
.ra-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.ra-select{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 8px;border-radius:8px;max-width:230px;}
.ra-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.ra-search{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 10px;border-radius:8px;min-width:220px;}
.ra-search::placeholder{color:var(--dsw-alias-label-secondary);}
.ra-body{flex:1 1 auto;min-height:0;display:flex;}
.ra-body.is-focus .ra-nav{display:none;}
.ra-body.is-focus .ra-article{padding-left:56px;padding-right:56px;}
.ra-nav{width:284px;flex:0 0 284px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:12px 10px 28px;}
.ra-nav-label{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);padding:6px 8px;}
.ra-stage{margin:0 0 10px;}
.ra-stage-head{display:flex;align-items:center;gap:6px;width:100%;appearance:none;border:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;letter-spacing:.09em;text-transform:uppercase;text-align:left;padding:7px 8px;border-radius:8px;cursor:pointer;position:sticky;top:0;z-index:2;}
.ra-stage-head:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
.ra-stage-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;}
.ra-stage-chevron{flex:0 0 10px;font-size:10px;color:var(--dsw-alias-label-secondary);}
.ra-stage-progress{height:3px;margin:2px 8px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}
.ra-stage-progress-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .2s ease;}
.ra-stage-lessons{display:flex;flex-direction:column;gap:1px;}
.ra-track-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ra-track-level{flex:0 0 auto;text-transform:none;letter-spacing:0;}
.ra-stage-count{flex:0 0 auto;font-variant-numeric:tabular-nums;letter-spacing:0;text-transform:none;}
.ra-lesson{display:flex;align-items:center;gap:9px;width:100%;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;padding:7px 8px;border-radius:8px;cursor:pointer;}
.ra-lesson:hover{background:var(--dsw-alias-bg-layer-1);}
.ra-lesson.is-active{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary),inset 0 0 0 1px var(--dsw-alias-border-l1);}
.ra-lesson-num{flex:0 0 21px;height:21px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}
.ra-lesson.is-done .ra-lesson-num{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base);}
.ra-lesson-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;}
.ra-lesson-track{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-secondary);}
.ra-lesson-min{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.ra-article{flex:1 1 auto;min-width:0;overflow-y:auto;padding:26px 34px 72px;}
.ra-article-inner{max-width:780px;margin:0 auto;}
.ra-crumbs{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-bottom:10px;}
.ra-lesson-head{display:flex;align-items:flex-start;gap:16px;}
.ra-lesson-head h1{margin:0;font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.015em;flex:1 1 auto;}
.ra-lesson-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.ra-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;}
.ra-level-core{color:var(--dsw-alias-label-secondary);}
.ra-level-advanced{color:var(--dsw-alias-brand-primary);}
.ra-level-industry{color:var(--dsw-alias-state-warn-primary);}
.ra-goal{margin:14px 0 22px;padding:12px 14px;border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);border-radius:0 8px 8px 0;color:var(--dsw-alias-label-primary);}
.ra-goal b{color:var(--dsw-alias-label-secondary);font-weight:600;font-size:11px;letter-spacing:.07em;text-transform:uppercase;display:block;margin-bottom:3px;}
.ra-section{margin:0 0 20px;}
.ra-section h2{margin:22px 0 8px;font-size:15px;font-weight:650;letter-spacing:-.01em;}
.ra-section p{margin:0 0 9px;color:var(--dsw-alias-label-primary);}
.ra-section ul{margin:6px 0 12px;padding-left:18px;color:var(--dsw-alias-label-primary);}
.ra-section li{margin:3px 0;}
.ra-tip{display:flex;gap:8px;margin:10px 0 14px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px;color:var(--dsw-alias-label-secondary);}
.ra-tip-mark{color:var(--dsw-alias-state-warn-primary);font-weight:700;}
.ra-pitfall{display:flex;gap:8px;margin:14px 0;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:9px;font-size:12.5px;color:var(--dsw-alias-label-primary);}
.ra-pitfall b{color:var(--dsw-alias-state-error-primary);font-size:11px;letter-spacing:.07em;text-transform:uppercase;flex:0 0 auto;}
.ra-production{margin:18px 0;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-1);}
.ra-production h3{margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-state-success-primary);}
.ra-production ul{margin:0;padding:0;list-style:none;}
.ra-production li{display:flex;gap:8px;margin:5px 0;font-size:12.5px;color:var(--dsw-alias-label-primary);}
.ra-check{flex:0 0 auto;color:var(--dsw-alias-state-success-primary);font-weight:700;}
.ra-crates{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:12px 0;}
.ra-crates-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-right:2px;}
.ra-crate{display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
.ra-refs{margin:16px 0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);}
.ra-refs h3{margin:0 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.ra-refs ul{margin:0;padding-left:16px;}
.ra-refs li{margin:3px 0;font-size:12.5px;}
.ra-link{color:var(--dsw-alias-brand-primary);text-decoration:none;word-break:break-word;}
.ra-link:hover{text-decoration:underline;}
.ra-link-mark{font-size:10px;margin-left:3px;color:var(--dsw-alias-label-secondary);}
.ra-track-project{margin:22px 0;padding:16px 18px;border:1px solid var(--dsw-alias-brand-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}
.ra-track-project-head{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.ra-track-project h3{margin:0;font-size:15px;font-weight:650;}
.ra-track-project p{margin:0 0 12px;font-size:12.5px;color:var(--dsw-alias-label-primary);}
.ra-track-project-cols{display:grid;grid-template-columns:1.4fr 1fr;gap:16px;}
.ra-track-project h4{margin:0 0 5px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.ra-track-project ul{margin:0;padding-left:16px;}
.ra-track-project li{font-size:12.5px;margin:3px 0;}
.ra-codeblock{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;overflow:hidden;margin:10px 0 14px;}
.ra-codeblock-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}
.ra-codeblock-lang{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.ra-pre{margin:0;padding:12px 14px;overflow-x:auto;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);tab-size:4;}
.ra-pre code{font:inherit;}
.ra-tok-kw{color:var(--dsw-alias-brand-primary);}
.ra-tok-str{color:var(--dsw-alias-state-success-primary);}
.ra-tok-num{color:var(--dsw-alias-state-warn-primary);}
.ra-tok-com{color:var(--dsw-alias-label-secondary);font-style:italic;}
.ra-tok-ty{color:var(--dsw-alias-label-primary);font-weight:600;}
.ra-ghost{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;padding:3px 9px;border-radius:7px;cursor:pointer;}
.ra-ghost:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
.ra-primary{appearance:none;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:8px;cursor:pointer;}
.ra-primary:hover{filter:brightness(1.06);}
.ra-complete{flex:0 0 auto;margin-top:2px;}
.ra-complete.is-done{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}
.ra-exercise{margin:26px 0 0;padding:16px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}
.ra-exercise-head{display:flex;align-items:center;gap:9px;margin-bottom:8px;}
.ra-badge{font-size:10px;letter-spacing:.09em;text-transform:uppercase;font-weight:700;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:3px 9px;}
.ra-exercise-prompt{margin:0 0 10px;font-size:13px;}
.ra-exercise-actions{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 10px;}
.ra-hint{margin:0 0 10px;padding:9px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12.5px;}
.ra-lesson-foot{display:flex;align-items:center;gap:10px;margin-top:28px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1);}
.ra-lesson-foot .ra-spacer{flex:1 1 auto;}
.ra-page{flex:1 1 auto;min-height:0;overflow-y:auto;padding:24px 34px 72px;}
.ra-page-inner{max-width:1180px;margin:0 auto;}
.ra-page-head h1{margin:0 0 4px;font-size:20px;font-weight:650;letter-spacing:-.015em;}
.ra-page-head p{margin:0 0 20px;color:var(--dsw-alias-label-secondary);font-size:12.5px;}
.ra-bp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px;align-items:start;}
.ra-bp{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:16px 18px;}
.ra-bp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}
.ra-bp-head h3{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em;}
.ra-bp-summary{margin:8px 0 10px;font-size:12.5px;color:var(--dsw-alias-label-primary);}
.ra-bp-block{margin:12px 0;}
.ra-bp-block h4{margin:0 0 5px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.ra-bp-block ol,.ra-bp-block ul{margin:0;padding-left:18px;}
.ra-bp-block li{font-size:12.5px;margin:3px 0;}
.ra-bp-component{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;margin:5px 0;font-size:12.5px;}
.ra-bp-component b{font-weight:600;}
.ra-bp-role{color:var(--dsw-alias-label-secondary);}
.ra-bp-lessons{display:flex;flex-wrap:wrap;gap:6px;}
.ra-bp-checklist li{color:var(--dsw-alias-label-primary);}
.ra-cheat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;align-items:start;}
.ra-cheat-group{border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.ra-cheat-group h2{margin:0;padding:9px 13px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);}
.ra-cheat-item{padding:9px 13px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.ra-cheat-item:last-child{border-bottom:0;}
.ra-cheat-name-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;}
.ra-cheat-name{font-size:11px;color:var(--dsw-alias-label-secondary);}
.ra-cheat-copy{padding:1px 7px;font-size:10px;}
.ra-cheat-code{margin:0;overflow-x:auto;font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);white-space:pre;}
.ra-empty{padding:18px 10px;font-size:12.5px;color:var(--dsw-alias-label-secondary);}
.ra-kind{display:inline-flex;align-items:center;padding:1px 6px;border-radius:5px;font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);margin-right:6px;border:1px solid var(--dsw-alias-border-l1);}
.ra-kind-repo{color:var(--dsw-alias-brand-primary);}
.ra-kind-paper{color:var(--dsw-alias-state-warn-primary);}
.ra-kind-video{color:var(--dsw-alias-state-error-primary);}
.ra-github{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:12px 0;}
.ra-github-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.ra-questions{margin:22px 0;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);}
.ra-questions-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px;}
.ra-questions h3{margin:0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-brand-primary);}
.ra-quiz-score{font-size:11px;color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums;}
.ra-question{margin:0 0 14px;}
.ra-question:last-child{margin-bottom:0;}
.ra-question-q{margin:0 0 6px;font-size:13px;}
.ra-options{display:flex;flex-direction:column;gap:5px;}
.ra-option{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;padding:6px 10px;border-radius:8px;cursor:pointer;}
.ra-option:hover{background:var(--dsw-alias-bg-layer-2);}
.ra-option:disabled{cursor:default;}
.ra-option.is-selected.is-correct{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);}
.ra-option.is-selected.is-wrong{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);}
.ra-question-explain{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);}
.ra-quickbytes{margin:18px 0;padding:14px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-1);}
.ra-quickbytes h3{margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-state-warn-primary);}
.ra-quickbyte{display:flex;gap:8px;margin:4px 0;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary);}
.ra-play{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:12px;padding:18px 22px 24px;}
.ra-play-toolbar{display:flex;flex-direction:column;gap:8px;}
.ra-play-heading{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
.ra-play-title{font-size:15px;font-weight:650;letter-spacing:-.01em;}
.ra-play-note{font-size:11px;color:var(--dsw-alias-label-secondary);}
.ra-play-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.ra-play-field,.ra-play-check{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.ra-play-body{flex:1 1 auto;min-height:0;display:flex;gap:12px;}
.ra-play-editor{flex:1 1 55%;min-width:0;display:flex;}
.ra-play-code{flex:1 1 auto;width:100%;min-height:220px;resize:none;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px 14px;tab-size:4;}
.ra-play-code:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.ra-play-output{flex:1 1 45%;min-width:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;}
.ra-play-empty{font-size:12.5px;color:var(--dsw-alias-label-secondary);}
.ra-play-error{margin-bottom:10px;padding:9px 11px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12.5px;}
.ra-play-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;}
.ra-badge-ok{color:var(--dsw-alias-state-success-primary);border:1px solid var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2);}
.ra-badge-bad{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);}
.ra-play-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.ra-play-section h4{margin:0 0 4px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);}
.ra-play-pre{margin:0 0 10px;overflow-x:auto;font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;}
.ra-play-stderr{color:var(--dsw-alias-label-secondary);}
.ra-play-section{margin-bottom:10px;}
.ra-play-suggestions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.ra-play-suggestions-label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin-right:2px;}
.ra-chip-button{cursor:pointer;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;}
.ra-chip-button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);}
.ra-play-notice{margin-bottom:10px;padding:8px 11px;border:1px solid var(--dsw-alias-state-success-primary);border-radius:8px;color:var(--dsw-alias-state-success-primary);font-size:12px;}
.ra-play-tests{margin:0 0 10px;padding:8px 11px;border-radius:8px;font-size:12px;font-variant-numeric:tabular-nums;}
.ra-play-tests.is-ok{color:var(--dsw-alias-state-success-primary);border:1px solid var(--dsw-alias-state-success-primary);}
.ra-play-tests.is-bad{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);}
.ra-play-diagnostics{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-direction:column;gap:6px;}
.ra-diag{border-left:3px solid var(--dsw-alias-border-l2);padding:6px 9px;background:var(--dsw-alias-bg-layer-2);border-radius:0 7px 7px 0;}
.ra-diag-error{border-left-color:var(--dsw-alias-state-error-primary);}
.ra-diag-warning{border-left-color:var(--dsw-alias-state-warn-primary);}
.ra-diag-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:12px;}
.ra-diag-sev{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:var(--dsw-alias-label-secondary);}
.ra-diag-error .ra-diag-sev{color:var(--dsw-alias-state-error-primary);}
.ra-diag-warning .ra-diag-sev{color:var(--dsw-alias-state-warn-primary);}
.ra-diag-msg{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary);}
.ra-diag-loc{margin-top:2px;font:10.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);}
.ra-diag-helps{margin:3px 0 0;padding-left:16px;font-size:11.5px;color:var(--dsw-alias-label-secondary);}
@media (max-width:900px){
  .ra-play-body{flex-direction:column;}
  .ra-play-code{min-height:180px;}
  .ra-play-output{min-height:160px;}
}
.ra-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:80;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:7px 15px;font-size:12px;}
@media (max-width:900px){
  .ra-nav{width:238px;flex-basis:238px;}
  .ra-article,.ra-page{padding:20px 18px 56px;}
  .ra-lesson-head{flex-direction:column;gap:8px;}
  .ra-track-project-cols{grid-template-columns:1fr;}
  .ra-bp-grid{grid-template-columns:1fr;}
}
`;

    // ----------------------------------------------------------------- plugin

    return {
      inject: ['slots'],
      apply(ctx) {
        localeService = ctx.get('locale') || null;
        layoutService = ctx.get('layout') || null;

        if (localeService) {
          ctx.effect(() => localeService.register(NS, 'en', DICT));
          try { boundTranslate = localeService.bind(NS); } catch (error) { boundTranslate = null; }
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'rust-academy',
          order: 20,
          label: () => t('panel.title'),
        }, SidebarIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'rust-academy',
        }, Panel));
      },
    };
  },
});
