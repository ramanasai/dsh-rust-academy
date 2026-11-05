/**
 * Embedded Rust track.
 *
 * Versions verified against crates.io / docs.rs while authoring:
 * embedded-hal 1.0.0, embedded-hal-async 1.0.0, embedded-hal-bus 0.3.0,
 * cortex-m 0.7.10, cortex-m-rt 0.7.7, rtic 2.4.0, rtic-monotonics 3.0.0,
 * embassy-executor 0.10.0, embassy-time 0.5.1, embassy-stm32 0.6.0,
 * embassy-boot 0.7.0, defmt 1.2.0, defmt-rtt 1.3.1, probe-rs 0.32.0.
 *
 * Data is JSON-compatible and consumed by the plugin build.
 */
export default {
  "key": "embedded",
  "prefix": "x",
  "title": "Embedded Rust",
  "blurb": "no_std firmware with embedded-hal, RTIC, Embassy, interrupts, DMA, power management and on-host testing.",
  "level": "industry",
  "project": {
    "title": "Capstone: a sensor-to-cloud firmware",
    "brief": "Build firmware that samples I2C and SPI sensors on a fixed schedule, buffers readings without a heap, sleeps between deadlines, and publishes over a serial or radio link with a resumable protocol. Every layer is testable: driver logic on the host, timing and DMA on target, and a measured power budget that you can defend against the battery you chose.",
    "deliverables": [
      "A HAL-based sensor driver crate written against embedded-hal 1.0, with a fake-bus unit test that runs on the host.",
      "An interrupt or DMA data path from peripheral to ring buffer, with a bounded drop policy and counters for drops and overruns.",
      "A power budget measured on hardware (active, idle, sleep) with the duty cycle and predicted battery life written down.",
      "On-host tests for framing, calibration and state-machine logic, distinct from on-target tests run through probe-rs.",
      "A published protocol over UART or a radio link with framing, checksums and resume after a dropped link.",
      "A short operations note: partition map, watchdog policy, reset-cause capture, and how an update rolls back."
    ],
    "stack": [
      "embedded-hal",
      "embedded-hal-async",
      "cortex-m",
      "cortex-m-rt",
      "embassy-executor",
      "embassy-time",
      "heapless",
      "defmt",
      "defmt-rtt",
      "probe-rs"
    ]
  },
  "lessons": [
    {
      "id": "x01",
      "n": 1,
      "title": "embedded-hal 1.0: traits as the port boundary",
      "minutes": 75,
      "level": "core",
      "goal": "Write a sensor driver against embedded-hal 1.0 traits so the same code runs on any MCU and is unit-testable on your laptop.",
      "sections": [
        {
          "h": "The dependency everyone inverts",
          "p": [
            "Every sensor driver starts life welded to one chip: bit-banged I2C on a specific STM32, register ops inlined next to a PAC. Port the product to an nRF52 and you rewrite the driver. embedded-hal inverts that dependency. The driver depends on a trait, the MCU support crate implements the trait, and the two are joined once in main by the type checker.",
            "embedded-hal 1.0.0, published January 2024, contains only traits and error kinds - no implementations, no HAL. That is deliberate: it is a vocabulary, not a driver layer. Anything that implements it (stm32f4xx-hal, embassy-stm32, rp2040-hal, esp-hal) can be substituted at the call site with zero runtime cost, because generics are monomorphised, not dispatched."
          ],
          "tip": "If a driver crate takes a concrete type like STM32F4xx instead of a HAL trait, you have found the port. Read the bounds before adopting it."
        },
        {
          "h": "What the traits actually promise",
          "p": [
            "Three details decide whether a driver is portable. First, every peripheral trait requires ErrorType with an associated Error, so the driver must stay generic over the error and never unwrap into a chip-specific type. Second, I2C is transaction-based: one call carries a slice of Read/Write operations, which is how repeated-START register reads survive on a shared bus. Third, SPI splits into SpiBus (full-duplex transfer) and SpiDevice (a bus plus its chip-select), so a driver can own a device without knowing whether other devices share the bus."
          ],
          "list": [
            "digital::{InputPin, OutputPin, StatefulOutputPin} - fallible set_high/set_low/set_state, plus is_high/is_low readback",
            "i2c::{I2c, Operation, ErrorKind} - one transaction, N operations, one error",
            "spi::{SpiBus, SpiDevice} - transfer_in_place for full duplex, transaction for CS framing",
            "delay::DelayNs - delay_ns/us/ms, default-implemented, used for sensor startup waits"
          ]
        },
        {
          "h": "The async dialect is a separate crate",
          "p": [
            "embedded-hal-async 1.0.0 mirrors the traits with async fn and is implemented by embassy HALs. They are not interchangeable: an async I2C bus does not implement the blocking trait, and a driver cannot be generic over both without a trait of your own. Pick per driver. Blocking is simpler and fine under 1 ms; async wins when a transfer waits on the bus for hundreds of microseconds and other tasks must run meanwhile.",
            "Note the object-safety trap: SpiDevice::transaction takes impl FnOnce, so it is not dyn-compatible. You cannot store a &mut dyn SpiDevice in a struct field, and a Vec of them is impossible. Generic bounds or an enum of concrete devices are the two honest options. Pick one per project and keep the two ecosystems apart: a single driver crate that tries to be generic over both blocking and async traits ends up with two copies of every function."
          ]
        }
      ],
      "exercise": {
        "prompt": "Make the MCP9808 driver below read its register pointer and data in one I2C transaction, then prove it with a fake bus that fails if it sees two separate transactions.",
        "starter": "use embedded_hal::i2c::{I2c, Operation};\n\npub struct Mcp9808<I> {\n    i2c: I,\n    addr: u8,\n}\n\nimpl<I: I2c> Mcp9808<I> {\n    pub fn new(i2c: I, addr: u8) -> Self {\n        Self { i2c, addr }\n    }\n\n    pub fn temperature_c(&mut self) -> Result<f32, I::Error> {\n        // TODO: write 0x05 (ambient temp), then read 2 bytes, in ONE transaction.\n        todo!()\n    }\n}",
        "hint": "Build a [Operation; 2] array: Operation::Write(&[reg]) then Operation::Read(&mut buf). Pass both to i2c.transaction(self.addr, &mut ops). Convert with i16::from_be_bytes, then divide by 16.0 - the MCP9808 reports 0.0625 C per LSB in 13 bits.",
        "solution": "use embedded_hal::i2c::{I2c, Operation};\n\npub struct Mcp9808<I> {\n    i2c: I,\n    addr: u8,\n}\n\nimpl<I: I2c> Mcp9808<I> {\n    pub fn new(i2c: I, addr: u8) -> Self {\n        Self { i2c, addr }\n    }\n\n    fn read_u16(&mut self, reg: u8) -> Result<u16, I::Error> {\n        let mut buf = [0u8; 2];\n        self.i2c.transaction(\n            self.addr,\n            &mut [Operation::Write(&[reg]), Operation::Read(&mut buf)],\n        )?;\n        Ok(u16::from_be_bytes(buf))\n    }\n\n    pub fn temperature_c(&mut self) -> Result<f32, I::Error> {\n        let raw = self.read_u16(0x05)? as i16;\n        Ok(raw as f32 / 16.0) // 0.0625 C per LSB\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    use embedded_hal::i2c::{ErrorType, Operation, SevenBitAddress};\n\n    struct FakeI2c {\n        transactions: usize,\n    }\n\n    impl ErrorType for FakeI2c {\n        type Error = core::convert::Infallible;\n    }\n\n    impl I2c<SevenBitAddress> for FakeI2c {\n        fn transaction(\n            &mut self,\n            _addr: SevenBitAddress,\n            ops: &mut [Operation<'_>],\n        ) -> Result<(), Self::Error> {\n            self.transactions += 1;\n            assert_eq!(ops.len(), 2, \"pointer write and read must share one transaction\");\n            if let Operation::Read(buf) = &mut ops[1] {\n                buf.copy_from_slice(&[0x0C, 0x80]); // 25.0 C\n            }\n            Ok(())\n        }\n    }\n\n    #[test]\n    fn reads_temperature_in_one_transaction() {\n        let mut dev = Mcp9808::new(FakeI2c { transactions: 0 }, 0x18);\n        assert!((dev.temperature_c().unwrap() - 25.0).abs() < 1e-3);\n    }\n}"
      },
      "questions": [
        {
          "q": "Why does embedded-hal 1.0 ship no implementations at all?",
          "options": [
            "To keep the crate small enough for 8-bit targets",
            "Because it defines a shared vocabulary that HAL crates implement, so drivers port across chips",
            "Because trait implementations cannot be no_std",
            "Because every HAL must implement its own private copy of the traits"
          ],
          "answer": 1,
          "explain": "It is a contract crate: only traits, error kinds and marker types. Each HAL implements them, so a driver written once compiles against every HAL with zero runtime dispatch."
        },
        {
          "q": "A driver stores `&mut dyn SpiDevice`. What breaks?",
          "options": [
            "Nothing, SpiDevice is object safe",
            "SpiDevice::transaction takes impl FnOnce, so the trait is not dyn-compatible",
            "SpiDevice has no associated Bus type",
            "SpiDevice requires alloc"
          ],
          "answer": 1,
          "explain": "Generic methods make a trait non-object-safe. Use a generic parameter or an enum over concrete device types instead of trait objects."
        },
        {
          "q": "When is embedded-hal-async the right choice over the blocking traits?",
          "options": [
            "Whenever the MCU has a hardware I2C peripheral",
            "When a transfer may wait on the bus long enough that other work must proceed meanwhile",
            "When the driver needs to be dyn-compatible",
            "Always: async is strictly faster than blocking"
          ],
          "answer": 1,
          "explain": "Async buys concurrency while waiting, at the cost of an executor and a second trait ecosystem. Short deterministic transfers are simpler blocking."
        }
      ],
      "quickbytes": [
        "Pin driver deps as embedded-hal = \"1.0\"; 1.0.0 landed January 2024 and the 0.2 traits are a different, incompatible API.",
        "Prefer I2c::transaction over read/write pairs: it keeps the register pointer and the read in one repeated-START frame.",
        "Keep the error type generic (I::Error); mapping it to a chip error in the driver destroys portability.",
        "Generic HAL bounds are monomorphised - you pay nothing at runtime for the abstraction."
      ],
      "production": [
        "Every driver crate has at least one unit test using a fake bus, so logic is exercised without hardware.",
        "Drivers bound on traits from embedded-hal 1.0, never on a concrete HAL type.",
        "Register-map constants carry the datasheet revision they were transcribed from.",
        "Timeouts exist at the call site, because the HAL traits themselves have no timeout parameter."
      ],
      "crates": [
        "embedded-hal",
        "embedded-hal-async",
        "embedded-hal-mock"
      ],
      "github": [
        {
          "name": "rust-embedded/embedded-hal - the trait definitions",
          "url": "https://github.com/rust-embedded/embedded-hal"
        }
      ],
      "pitfall": "Using two separate write then read calls for a register read. Another master can interleave, and on some peripherals the second call restarts the bus and loses the pointer.",
      "resources": [
        {
          "title": "embedded-hal 1.0 API: i2c, spi, digital, delay traits",
          "url": "https://docs.rs/embedded-hal/latest/embedded_hal/",
          "kind": "docs"
        },
        {
          "title": "The Embedded Rust Book: portability and the HAL layer",
          "url": "https://github.com/rust-embedded/book",
          "kind": "repo"
        },
        {
          "title": "embedded-hal repository: trait RFCs and changelog",
          "url": "https://github.com/rust-embedded/embedded-hal",
          "kind": "repo"
        },
        {
          "title": "embedded-hal-mock: fakes for on-host driver tests",
          "url": "https://github.com/rust-embedded/embedded-hal-mock",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x02",
      "n": 2,
      "title": "no_std: what you lose, what you must supply",
      "minutes": 65,
      "level": "core",
      "goal": "Turn a std binary into a freestanding no_std image: panic handler, entry point, no allocator, and a profile that actually links.",
      "sections": [
        {
          "h": "There is no operating system underneath",
          "p": [
            "A bare-metal target such as thumbv7em-none-eabihf has target_os = \"none\". std cannot link: there are no threads to spawn, no filesystem, no clock, no allocator to hand out pages. Adding #![no_std] is not a style choice, it is the only thing that links. You keep core - slices, Option, Result, iterators, atomics, fmt - and lose everything that needs an OS.",
            "What disappears in practice: Vec and String (they need an allocator), std::time, println!, threads, and the math functions on f32/f64 such as sqrt and sin, which live in std rather than core. The libm crate provides those for no_std builds. core::time::Duration exists, but there is no Instant: wall-clock time has to come from a peripheral."
          ]
        },
        {
          "h": "The three items the linker demands",
          "p": [
            "A no_std binary must supply a panic handler and an entry point, and must not rely on unwinding. #[panic_handler] is a function taking &PanicInfo and returning !; panic-halt loops forever, panic-probe prints through defmt and then halts the core. #[no_main] plus a runtime crate (cortex-m-rt, esp-hal) provides the reset entry; on Cortex-M you write #[entry] and the runtime builds the vector table.",
            "Set panic = \"abort\" in the release profile. Unwinding requires a personality routine and an unwinder that only std provides, so without the setting the linker fails with an obscure \"cannot find eh_personality\" error that sends people hunting for the wrong bug entirely. Aborting on panic is also the honest behaviour on a device with no supervisor: there is nothing to catch and retry, so the panic path should end in a reset or a halt, not in unwinding through frames that were never designed for it."
          ],
          "code": "#![no_std]\n#![no_main]\n\nuse cortex_m_rt::entry;\nuse panic_halt as _; // provides #[panic_handler]\n\n#[entry]\nfn main() -> ! {\n    // no std::process::exit, so main never returns\n    loop {\n        cortex_m::asm::wfi();\n    }\n}\n\n// Cargo.toml\n// [profile.release]\n// panic = \"abort\"\n// lto = true\n// opt-level = \"s\"\n// codegen-units = 1",
          "tip": "panic = \"abort\" is mandatory in no_std. Its absence surfaces as an eh_personality link error, not as a panic message."
        },
        {
          "h": "Allocation is a decision, not a default",
          "p": [
            "You can opt into alloc by declaring a global allocator and an allocation-error handler. embedded-alloc supplies both, wrapping a fixed static byte pool. The moment you do, every Box and Vec can fail at runtime, fragmentation becomes a field bug, and your worst-case RAM figure stops being a number you can read off the map file.",
            "The alternative is heapless: fixed-capacity Vec, String, Deque and Queue with capacity in the type. Push returns Err when full, which forces you to decide what happens at capacity at the call site. For firmware that must survive a week unattended, that decision is the feature."
          ],
          "list": [
            "No alloc: capacity is a compile-time constant, no fragmentation, but every container has a hard limit",
            "embedded-alloc: ergonomic, but peak usage and fragmentation are runtime properties you must test",
            "Formatting pulls in core::fmt machinery; defmt keeps strings in flash instead"
          ]
        }
      ],
      "exercise": {
        "prompt": "Convert this std program into a no_std Cortex-M image that blinks a counter without allocation: remove std, add the panic handler and entry, and keep the arithmetic in a fixed-size buffer.",
        "starter": "// std version - does not link on thumbv7em-none-eabihf\nuse std::vec::Vec;\n\nfn main() {\n    let mut samples: Vec<u16> = Vec::new();\n    for i in 0..8 {\n        samples.push(i * 3);\n    }\n    println!(\"{:?}\", samples);\n}",
        "hint": "Replace Vec with [u16; 8] and a length counter, drop println for a defmt or semihosting call, add #![no_std] #![no_main], use cortex_m_rt::entry and panic_halt. Add panic = \"abort\" to the release profile.",
        "solution": "#![no_std]\n#![no_main]\n\nuse cortex_m_rt::entry;\nuse panic_halt as _;\n\nconst CAP: usize = 8;\n\nstruct Ring {\n    buf: [u16; CAP],\n    len: usize,\n    head: usize,\n}\n\nimpl Ring {\n    const fn new() -> Self {\n        Self { buf: [0; CAP], len: 0, head: 0 }\n    }\n\n    fn push(&mut self, v: u16) -> Result<(), u16> {\n        if self.len == CAP {\n            return Err(v); // caller decides what to drop\n        }\n        self.buf[(self.head + self.len) % CAP] = v;\n        self.len += 1;\n        Ok(())\n    }\n\n    fn pop(&mut self) -> Option<u16> {\n        if self.len == 0 {\n            return None;\n        }\n        let v = self.buf[self.head];\n        self.head = (self.head + 1) % CAP;\n        self.len -= 1;\n        Some(v)\n    }\n}\n\n#[entry]\nfn main() -> ! {\n    let mut ring = Ring::new();\n    for i in 0..16u16 {\n        let _ = ring.push(i * 3); // full ring is a normal, handled outcome\n    }\n    let _first = ring.pop();\n    loop {\n        cortex_m::asm::wfi();\n    }\n}"
      },
      "questions": [
        {
          "q": "Which of these is unavailable in a no_std crate without extra work?",
          "options": [
            "core::result::Result",
            "Vec and String",
            "core::fmt::Write",
            "AtomicU32"
          ],
          "answer": 1,
          "explain": "Vec and String live in alloc and need a #[global_allocator]. Result, fmt and atomics are all in core."
        },
        {
          "q": "The linker reports \"cannot find eh_personality\". What is the usual cause?",
          "options": [
            "The panic handler returns () instead of !",
            "panic = \"abort\" is missing, so the compiler emits unwind tables nothing can satisfy",
            "The target triple has no FPU",
            "memory.x declares the wrong RAM length"
          ],
          "answer": 1,
          "explain": "Unwinding needs a personality routine that only std supplies. Setting panic = \"abort\" in the profile removes the requirement."
        }
      ],
      "quickbytes": [
        "Add #![no_std] and #![no_main] together with a runtime entry (#[entry] or a HAL main macro).",
        "Set panic = \"abort\" in every profile that links for bare metal.",
        "Need sin/sqrt? Use libm; core has no transcendental math.",
        "Choose heapless unless you can afford to test peak heap use and fragmentation at runtime."
      ],
      "production": [
        "Release profile pins panic = \"abort\", lto = true and opt-level = \"s\" so size regressions are attributable.",
        "The panic strategy is explicit: panic-halt in production, panic-probe on developer builds.",
        "No allocator is linked unless a written justification and a peak-usage test exist.",
        "Container capacities are named constants, and the full-capacity path is covered by a unit test."
      ],
      "crates": [
        "cortex-m-rt",
        "panic-halt",
        "panic-probe",
        "heapless"
      ],
      "github": [
        {
          "name": "rust-embedded/cortex-m-rt - the reset runtime",
          "url": "https://github.com/rust-embedded/cortex-m-rt"
        }
      ],
      "pitfall": "Reaching for Vec during bring-up \"just to print something\", then discovering at the end of the project that the heap peak is 3 KB above the RAM budget with no time to refactor.",
      "resources": [
        {
          "title": "cortex-m-rt: #[entry], link sections, memory.x",
          "url": "https://docs.rs/cortex-m-rt/latest/cortex_m_rt/",
          "kind": "docs"
        },
        {
          "title": "The Embedded Rust Book: no_std, panicking, allocators",
          "url": "https://github.com/rust-embedded/book",
          "kind": "repo"
        },
        {
          "title": "heapless: fixed-capacity containers for no_std",
          "url": "https://docs.rs/heapless/latest/heapless/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "x03",
      "n": 3,
      "title": "Cortex-M boot: vector table, memory.x, reset path",
      "minutes": 80,
      "level": "core",
      "goal": "Explain what happens between power-on and your first Rust statement, and control it through memory.x, the vector table and the linker script.",
      "sections": [
        {
          "h": "Two words of flash decide everything",
          "p": [
            "On Cortex-M the hardware reads the first two words of the vector table at reset: the initial stack pointer, then the reset handler address. Every later entry is an exception vector. On an STM32 the table lives at 0x0800_0000 because that is where flash is aliased for boot; a bootloader relocates it by writing VTOR and jumping into the application.",
            "cortex-m-rt generates that table from the PAC, so the vectors are the ones your chip actually has. If you point the linker at the wrong device feature, you get a table for a different part and interrupts land on the wrong handler - the firmware boots, then corrupts state the first time the UART fires."
          ],
          "code": "MEMORY\n{\n  FLASH : ORIGIN = 0x08000000, LENGTH = 512K\n  RAM   : ORIGIN = 0x20000000, LENGTH = 128K\n}\n\n_stack_start = ORIGIN(RAM) + LENGTH(RAM);\n\n/* with a bootloader at 0x08000000, the app image starts later */\n/* FLASH : ORIGIN = 0x08020000, LENGTH = 384K */",
          "tip": "Do not hand-edit LENGTH from memory. Copy it from the datasheet table for the exact part number, including the suffix that changes flash size."
        },
        {
          "h": "What the startup code does before main",
          "p": [
            "The reset handler copies .data from its load address in flash to RAM, zeroes .bss, optionally runs #[pre_init], then calls main. Data in .uninit is skipped entirely, which is how a struct survives a soft reset. Knowing this ordering matters: any static with a Drop impl is never dropped, and a const-initialised static lives in .data, costing RAM for every byte.",
            "Stack overflow is not detected by default. The stack grows down from _stack_start into whatever section sits below it - usually .bss - so an overflow silently corrupts globals and the symptom appears minutes later in unrelated code, often after a field deployment. There is no guard page unless you build one: an MPU region at the boundary, or flip-link reordering so the stack grows out of RAM and faults immediately. Either way, the detection has to be designed in before the first unexplained reset."
          ],
          "list": [
            ".text and .rodata: execute and read in place from flash, no RAM cost",
            ".data: initialised in flash, copied to RAM by the reset handler",
            ".bss: zeroed at startup, costs RAM but no flash",
            ".uninit: not touched at boot, contents undefined after power-on"
          ]
        },
        {
          "h": "Building for the right instruction set",
          "p": [
            "Use thumbv7em-none-eabihf for Cortex-M4F and M7 with an FPU, thumbv7em-none-eabi when you want to forbid FPU instructions, thumbv6m-none-eabi for M0/M0+. A wrong triple does not always fail loudly: selecting eabihf on an M0 gives illegal-instruction faults at the first float.",
            "Put the target and linker arguments in .cargo/config.toml so every build and every CI job is identical, and add a runner line so cargo run flashes and attaches automatically. Anything typed only in a shell alias or a README will be missing from the release build the day someone else cuts it. The config also makes the linker script argument explicit, which matters once a bootloader moves the flash origin and the default link.x no longer describes your layout."
          ],
          "code": "# .cargo/config.toml\n[build]\ntarget = \"thumbv7em-none-eabihf\"\n\n[target.thumbv7em-none-eabihf]\nrunner = \"probe-rs run --chip STM32F411CEUx\"\nrustflags = [\n  \"-C\", \"link-arg=-Tlink.x\",\n  \"-C\", \"link-arg=-Tdefmt.x\",\n]\n\n# build.rs copies memory.x into OUT_DIR and emits link-search\n# $ cargo size --bin firmware\n#    text    data     bss     dec     hex\n#   18240     152    6144   24536    5fd8"
        }
      ],
      "exercise": {
        "prompt": "Given a board with 512 KiB flash and 128 KiB RAM, plus a 128 KiB bootloader at 0x08000000, write the memory.x for the application and compute how much stack you can claim without touching the 6 KiB of statics reported by cargo size.",
        "starter": "MEMORY\n{\n  FLASH : ORIGIN = ?, LENGTH = ?\n  RAM   : ORIGIN = 0x20000000, LENGTH = ?\n}\n\n_stack_start = ORIGIN(RAM) + LENGTH(RAM);",
        "hint": "Move FLASH origin past the bootloader: 0x08000000 + 0x20000 = 0x08020000, and reduce the length by the same 128 KiB. RAM stays at 0x20000000/128K. Stack ceiling is RAM minus statics, minus a margin for the heap you do not have.",
        "solution": "MEMORY\n{\n  FLASH : ORIGIN = 0x08020000, LENGTH = 384K\n  RAM   : ORIGIN = 0x20000000, LENGTH = 128K\n}\n\n_stack_start = ORIGIN(RAM) + LENGTH(RAM);\n\n/* Stack budget = 128K RAM - 6K statics = 122K ceiling.\n   Practical figure: reserve a 1-2K margin and measure the high-water\n   mark by painting the stack with 0xDEADBEEF before it is used. */\n\n// src/main.rs\n#![no_std]\n#![no_main]\n\nuse cortex_m_rt::entry;\nuse panic_halt as _;\n\n#[entry]\nfn main() -> ! {\n    // first statement runs after .data copy and .bss zeroing\n    loop {\n        cortex_m::asm::wfi();\n    }\n}"
      },
      "questions": [
        {
          "q": "The first word of the vector table holds what?",
          "options": [
            "The address of the reset handler",
            "The initial stack pointer value",
            "The VTOR offset",
            "A CRC of the image"
          ],
          "answer": 1,
          "explain": "Word 0 is the initial SP, word 1 is the reset vector. That is why a corrupted image usually faults before any of your code runs."
        },
        {
          "q": "Which section costs RAM but no flash?",
          "options": [
            ".text",
            ".rodata",
            ".bss",
            ".data"
          ],
          "answer": 2,
          "explain": ".bss is zero-filled by the reset handler, so it occupies RAM only. .data costs both: an initialiser image in flash plus the RAM it is copied into."
        },
        {
          "q": "Why does the eabihf target triple matter on an M0?",
          "options": [
            "It only changes optimisation level",
            "It enables FPU instructions the M0 does not have, causing illegal-instruction faults",
            "It removes the need for a panic handler",
            "It doubles the vector table size"
          ],
          "answer": 1,
          "explain": "M0/M0+ have no FPU. Building with hardware-float for them emits instructions that fault at runtime, usually the first time a float is touched."
        }
      ],
      "quickbytes": [
        "Word 0 of the vector table is the initial SP; word 1 is the reset handler.",
        "cargo size --bin fw prints text/data/bss - add data+bss to get true RAM use.",
        "A bootloader shifts FLASH ORIGIN and shrinks LENGTH by exactly its own size.",
        "Keep target triple and linker args in .cargo/config.toml, never in a shell alias."
      ],
      "production": [
        "memory.x lengths are transcribed from the datasheet for the exact ordering code, not from a sibling part.",
        "The vector table device feature matches the silicon, verified by an interrupt smoke test on real hardware.",
        "An .uninit struct records the reset cause before main so field failures can be triaged.",
        "CI builds the exact target triple and fails on unexpected .text growth beyond a budget."
      ],
      "crates": [
        "cortex-m-rt",
        "cortex-m",
        "panic-halt"
      ],
      "github": [
        {
          "name": "rust-embedded/cortex-m-rt - startup code and linker scripts",
          "url": "https://github.com/rust-embedded/cortex-m-rt"
        }
      ],
      "pitfall": "Copying memory.x from a similar board with 256K flash. Everything links, the image is small, and the board bricks the first time a build crosses the real boundary.",
      "resources": [
        {
          "title": "cortex-m-rt: linker sections and the reset handler",
          "url": "https://docs.rs/cortex-m-rt/latest/cortex_m_rt/",
          "kind": "docs"
        },
        {
          "title": "The Embedded Rust Book: memory layout and memory.x",
          "url": "https://github.com/rust-embedded/book",
          "kind": "repo"
        },
        {
          "title": "cortex-m crate: SCB, NVIC, asm helpers",
          "url": "https://docs.rs/cortex-m/latest/cortex_m/",
          "kind": "docs"
        },
        {
          "title": "cortex-m-rt repository: link.x and device.x",
          "url": "https://github.com/rust-embedded/cortex-m-rt",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x04",
      "n": 4,
      "title": "Interrupts, priorities and critical sections",
      "minutes": 90,
      "level": "advanced",
      "goal": "Share state between an ISR and main without losing updates or blowing your latency budget, and know what interrupt::free really costs.",
      "sections": [
        {
          "h": "Priorities are preemption, not ordering",
          "p": [
            "On Cortex-M a lower numeric priority is more urgent. An interrupt can preempt any running handler of lower urgency, and the hardware stacks the preempted context. The same-priority rule is the one people miss: handlers at the same priority never preempt each other, so they can share data without masking - a fact RTIC builds its whole model on.",
            "Not all 8 priority bits exist. Most parts implement 3 or 4, so writing 0x01 to a 3-bit implementation reads back as 0x20: the low bits are ignored. If two handlers that you think differ actually round to the same priority, your \"preemption\" silently becomes serialisation."
          ],
          "code": "use cortex_m::peripheral::NVIC;\nuse stm32f4xx_hal::pac::{self, interrupt};\n\n// priority 0 = most urgent. Check how many bits this part implements.\nunsafe { NVIC::set_priority(pac::Interrupt::TIM2, 0x10) };\nunsafe { NVIC::unmask(pac::Interrupt::TIM2) };\n\n#[interrupt]\nfn TIM2() {\n    // keep this short: a few microseconds at most\n}"
        },
        {
          "h": "A critical section is a latency debt",
          "p": [
            "cortex_m::interrupt::free masks every configurable interrupt by setting PRIMASK, runs the closure, then restores the previous mask. It is correct and it is blunt: for its duration, no interrupt runs, so UART bytes can be dropped and control loops miss deadlines. Budget it in microseconds and measure it, because the compiler may keep the section open longer than the source suggests.",
            "interrupt::free is also not reentrant-safe in the naive sense: nesting is fine because PRIMASK is saved and restored, but calling it from a high-priority handler to touch a lock held by a low-priority handler is how you build a priority inversion with no ceiling to save you."
          ],
          "code": "use core::cell::RefCell;\nuse cortex_m::interrupt::{free, Mutex};\n\nstatic COUNTER: Mutex<RefCell<u32>> = Mutex::new(RefCell::new(0));\n\nfn bump() {\n    free(|cs| {\n        let mut c = COUNTER.borrow(cs).borrow_mut();\n        *c += 1; // read-modify-write is atomic w.r.t. interrupts here\n    });\n}\n\nfn snapshot() -> u32 {\n    free(|cs| *COUNTER.borrow(cs).borrow())\n}",
          "tip": "Use the CriticalSection token, not a bool flag of your own. The token proves at the type level that interrupts are masked."
        },
        {
          "h": "Cheaper than masking",
          "p": [
            "Three patterns beat a global critical section. For single-word counters, use an atomic: fetch_add on a u32 is a single instruction and needs no mask. For producer-consumer data, use a lock-free SPSC queue where the ISR only writes and main only reads, so no lock exists. For a large shared struct, use a seqlock or double buffer with an atomic index swap.",
            "When you must mask, mask the smallest possible window: compute outside the closure, move the result in. And measure the real cost - toggle a GPIO inside and outside the section and look at the difference on a logic analyser; the datasheet figure is not your figure."
          ],
          "list": [
            "Atomic counter: one instruction, no masking, no reentrancy hazard",
            "SPSC ring: ISR writes, task reads, indices are atomics",
            "Double buffer: write the inactive half, publish with a single atomic store",
            "Masking: correct everywhere, costs latency everywhere it is used"
          ]
        }
      ],
      "exercise": {
        "prompt": "A timer ISR increments a 32-bit sample counter and main periodically reads and clears it. Rewrite the pair so no sample is lost and main never masks interrupts for more than one store.",
        "starter": "static mut SAMPLES: u32 = 0; // wrong on every level\n\nfn TIM2() {\n    unsafe { SAMPLES += 1; }\n}\n\nfn take() -> u32 {\n    unsafe {\n        let n = SAMPLES;\n        SAMPLES = 0;\n        n\n    }\n}",
        "hint": "Use AtomicU32 with fetch_add in the ISR and swap(0) in main. Both are single-instruction read-modify-writes, so the read-and-clear is atomic without a critical section.",
        "solution": "use core::sync::atomic::{AtomicU32, Ordering};\n\nstatic SAMPLES: AtomicU32 = AtomicU32::new(0);\n\nfn TIM2() {\n    // fetch_add compiles to LDREX/STREX or a single instruction;\n    // no critical section needed for a sole writer ring counter.\n    SAMPLES.fetch_add(1, Ordering::Relaxed);\n}\n\n/// Returns samples seen since the previous call without losing any.\nfn take() -> u32 {\n    SAMPLES.swap(0, Ordering::AcqRel)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn take_drains_and_resets() {\n        SAMPLES.store(0, Ordering::Relaxed);\n        SAMPLES.fetch_add(7, Ordering::Relaxed);\n        assert_eq!(take(), 7);\n        assert_eq!(take(), 0);\n    }\n}"
      },
      "questions": [
        {
          "q": "Two interrupts are configured with the same priority. What happens?",
          "options": [
            "The more recently configured one wins",
            "Neither can preempt the other; they run to completion in turn",
            "The hardware arbitrates by vector number and preempts",
            "Both handlers run concurrently on separate cores"
          ],
          "answer": 1,
          "explain": "Preemption requires a strictly higher urgency (lower number). Equal priority means serialised execution, which also means they can share state without masking."
        },
        {
          "q": "What is the real cost of cortex_m::interrupt::free?",
          "options": [
            "A context switch to a kernel thread",
            "A global mask that delays every configurable interrupt for the section duration",
            "Only the cost of the closure",
            "Nothing: PRIMASK is free on Cortex-M"
          ],
          "answer": 1,
          "explain": "PRIMASK blocks all maskable interrupts, so UART and timer latency grow by the section length. It is correct but must be budgeted and measured."
        }
      ],
      "quickbytes": [
        "Lower number = higher urgency; verify how many priority bits the part implements before trusting a value.",
        "Atomic fetch_add/swap beats interrupt::free for counters: no masking, no lost updates.",
        "Keep critical sections to a handful of instructions; measure with a GPIO toggle, not a guess.",
        "On M0/M0+ there is no BASEPRI, so priority-ceiling schemes degrade to source masking."
      ],
      "production": [
        "Every ISR has a measured worst-case duration in the design notes, checked on hardware.",
        "Shared mutable state is an atomic, an SPSC queue, or a CriticalSection-protected cell - never static mut.",
        "Interrupt priorities are declared in one place with a comment naming the part-specific bit width.",
        "A logic-analyser capture of the worst-case path is kept as a regression reference."
      ],
      "crates": [
        "cortex-m",
        "critical-section",
        "heapless"
      ],
      "github": [
        {
          "name": "rust-embedded/cortex-m - NVIC, PRIMASK, Mutex",
          "url": "https://github.com/rust-embedded/cortex-m"
        }
      ],
      "pitfall": "static mut shared with an ISR compiles fine and fails intermittently: the compiler may cache the value in a register across the interrupt, and the write is torn on some paths.",
      "resources": [
        {
          "title": "cortex-m: interrupt::free, Mutex, NVIC",
          "url": "https://docs.rs/cortex-m/latest/cortex_m/interrupt/index.html",
          "kind": "docs"
        },
        {
          "title": "critical-section: the portable masking abstraction",
          "url": "https://docs.rs/critical-section/latest/critical_section/",
          "kind": "docs"
        },
        {
          "title": "The Embedded Rust Book: concurrency and shared state",
          "url": "https://github.com/rust-embedded/book",
          "kind": "repo"
        },
        {
          "title": "Jon Gjengset: atomics and memory ordering in Rust",
          "url": "https://www.youtube.com/@jonhoo",
          "kind": "video"
        }
      ]
    },
    {
      "id": "x05",
      "n": 5,
      "title": "RTIC 2: static priorities and resource ceilings",
      "minutes": 100,
      "level": "advanced",
      "goal": "Structure firmware as priority-ordered tasks whose shared resources are resolved at compile time by the Stack Resource Policy.",
      "sections": [
        {
          "h": "The framework is a macro and a proof",
          "p": [
            "RTIC 2.4 takes over your module: #[rtic::app] reads the task declarations, computes which tasks touch which resources, and generates the interrupt handlers, the resource locks and a single stack. Nothing is allocated at runtime and there is no scheduler in the usual sense - the NVIC is the scheduler, and priorities are the ones you declared.",
            "The payoff is that deadlock and data races are excluded by construction rather than by review. If two tasks share a resource, RTIC knows their priorities and inserts the right ceiling protocol; if a task tries to lock a resource it did not declare, the code does not compile."
          ]
        },
        {
          "h": "Shared, local, and the ceiling protocol",
          "p": [
            "Resources go in one of two structs. #[shared] holds state touched by more than one task, and each access goes through .lock(|r| ...). #[local] holds state owned by exactly one task, so access is direct and free. #[init] returns both structs, and the macro verifies every access at compile time.",
            "Under the Stack Resource Policy, a resource has a ceiling equal to the highest priority of any task that uses it. Locking raises the caller to that ceiling and, on ARMv7-M, writes BASEPRI so only more urgent interrupts can preempt. That makes the critical section as short as possible and rules out unbounded priority inversion - unlike a plain mutex, which lets a medium-priority task starve a low-priority lock holder."
          ],
          "code": "#[rtic::app(device = stm32f4xx_hal::pac, peripherals = true)]\nmod app {\n    use super::*;\n\n    #[shared]\n    struct Shared {\n        samples: u32,\n    }\n\n    #[local]\n    struct Local {\n        led: stm32f4xx_hal::gpio::PA5<stm32f4xx_hal::gpio::Output>,\n    }\n\n    #[init]\n    fn init(cx: init::Context) -> (Shared, Local) {\n        (Shared { samples: 0 }, Local { led: todo!() })\n    }\n\n    // Hardware task: bound to an interrupt vector, priority 1.\n    #[task(binds = TIM2, priority = 1, shared = [samples])]\n    fn tick(mut cx: tick::Context) {\n        cx.shared.samples.lock(|s| *s = s.wrapping_add(1));\n    }\n\n    // Higher priority, same resource: RTIC raises the ceiling to 3.\n    #[task(binds = EXTI0, priority = 3, shared = [samples], local = [led])]\n    fn button(mut cx: button::Context) {\n        let n = cx.shared.samples.lock(|s| *s);\n        if n > 0 {\n            cx.local.led.set_high().ok();\n        }\n    }\n}",
          "tip": "Do not reach for a global critical section inside an RTIC task. Declare the resource and let the ceiling protocol narrow the mask for you."
        },
        {
          "h": "Software tasks and back pressure",
          "p": [
            "A task without binds is a software task: it runs in thread mode and is started with spawn(). In RTIC 2 spawn returns a Result, so a saturated task queue is an error you handle, not a panic. That is the difference between firmware that drops a sample under load and firmware that resets in a customer's hands.",
            "Software tasks are also where async lives. With a monotonic registered (rtic-monotonics), a task can be async and await delays while the rest of the system keeps running. Deadlines then come from the monotonic and are enforced by the same priority machinery."
          ],
          "list": [
            "Hardware task: binds to a vector, runs at its declared priority, cannot be spawned",
            "Software task: spawn() from anywhere, queued at its priority, Result on overflow",
            "Init runs at the lowest priority before anything else, with interrupts masked",
            "Idle runs in thread mode when no task is ready - the place for sleep"
          ]
        }
      ],
      "exercise": {
        "prompt": "Add a second producer: an EXTI0 handler must add 100 to the same samples counter, at priority 3, while the TIM2 handler stays at priority 1. Then explain what BASEPRI value is active while each lock is held.",
        "starter": "#[rtic::app(device = stm32f4xx_hal::pac, peripherals = true)]\nmod app {\n    #[shared]\n    struct Shared { samples: u32 }\n\n    #[task(binds = TIM2, priority = 1, shared = [samples])]\n    fn tick(mut cx: tick::Context) {\n        cx.shared.samples.lock(|s| *s += 1);\n    }\n}",
        "hint": "Declare a second task with priority = 3 and shared = [samples]. The ceiling of samples becomes 3, so the TIM2 lock masks everything at priority 4 and below while it runs; the EXTI0 lock masks nothing more urgent than itself.",
        "solution": "#[rtic::app(device = stm32f4xx_hal::pac, peripherals = true)]\nmod app {\n    #[shared]\n    struct Shared {\n        samples: u32,\n    }\n\n    #[local]\n    struct Local {}\n\n    #[init]\n    fn init(_cx: init::Context) -> (Shared, Local) {\n        (Shared { samples: 0 }, Local {})\n    }\n\n    #[task(binds = TIM2, priority = 1, shared = [samples])]\n    fn tick(mut cx: tick::Context) {\n        // ceiling of `samples` is 3, so this lock raises to 3:\n        // BASEPRI blocks priorities 4..=15, EXTI0 (3) can still preempt.\n        cx.shared.samples.lock(|s| *s = s.wrapping_add(1));\n    }\n\n    #[task(binds = EXTI0, priority = 3, shared = [samples])]\n    fn button(mut cx: button::Context) {\n        // already at the ceiling: locking lowers nothing, masks nothing new.\n        cx.shared.samples.lock(|s| *s = s.saturating_add(100));\n    }\n}"
      },
      "questions": [
        {
          "q": "What determines the ceiling of an RTIC shared resource?",
          "options": [
            "The priority of the task that created it in init",
            "The highest priority among the tasks that declare it",
            "The NVIC vector number it is assigned to",
            "The number of tasks that share it"
          ],
          "answer": 1,
          "explain": "The ceiling is the maximum priority of its users. Locking raises the caller to that level, which bounds the blocking any higher-priority task can suffer."
        },
        {
          "q": "spawn() on a software task returns Result in RTIC 2. Why does that matter?",
          "options": [
            "It reports whether the task panicked",
            "A full task queue becomes a handled error instead of a panic or silent drop",
            "It indicates whether the interrupt is enabled",
            "It is only for async tasks"
          ],
          "answer": 1,
          "explain": "Capacity is finite and static. Making overflow explicit forces a policy decision at the call site - drop, retry, or back-pressure."
        },
        {
          "q": "Why can a single stack serve all RTIC tasks?",
          "options": [
            "Tasks are run on separate cores",
            "Tasks never preempt each other",
            "Preemption is bounded by the ceiling protocol and the stack is reused for nested preemption",
            "RTIC allocates a heap and moves stacks there"
          ],
          "answer": 2,
          "explain": "RTIC relies on the hardware stacking of preempted contexts; nested preemption depth is bounded by the number of priorities, not by task count, so one stack suffices."
        }
      ],
      "quickbytes": [
        "Declare a resource shared only when two tasks really touch it; local access is free, shared access is not.",
        "The ceiling protocol needs BASEPRI, so on M0/M0+ RTIC falls back to interrupt source masking.",
        "Treat SpawnError as a design signal: either raise capacity or add explicit back-pressure.",
        "priority = 0 is the most urgent; keep long tasks at low priority so they cannot delay control loops."
      ],
      "production": [
        "Every shared resource has a documented ceiling and the reasoning for its priority assignment.",
        "Software-task queue capacity is derived from burst measurement, and overflow is logged, not ignored.",
        "WCET of each task is measured on target and compared with its period before release.",
        "The idle task always enters a low-power instruction rather than busy-looping."
      ],
      "crates": [
        "rtic",
        "rtic-monotonics",
        "cortex-m"
      ],
      "github": [
        {
          "name": "rtic-rs/rtic - framework and examples",
          "url": "https://github.com/rtic-rs/rtic"
        }
      ],
      "pitfall": "Putting a long computation in a high-priority task \"because it is important\". It preempts everything below it, and every lower-priority deadline silently stretches.",
      "resources": [
        {
          "title": "RTIC 2 book: resource ceilings and task priorities",
          "url": "https://rtic.rs/2/book/en/",
          "kind": "docs"
        },
        {
          "title": "rtic crate API reference",
          "url": "https://docs.rs/rtic/latest/rtic/",
          "kind": "docs"
        },
        {
          "title": "rtic-monotonics: timebase for async RTIC tasks",
          "url": "https://docs.rs/rtic-monotonics/latest/rtic_monotonics/",
          "kind": "docs"
        },
        {
          "title": "rtic examples: board-specific starting points",
          "url": "https://github.com/rtic-rs/rtic/tree/master/examples",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x06",
      "n": 6,
      "title": "Embassy: async tasks on one stack",
      "minutes": 100,
      "level": "advanced",
      "goal": "Model firmware as concurrent async tasks with statically allocated futures, and know exactly where Embassy gives up preemption.",
      "sections": [
        {
          "h": "A future is the task",
          "p": [
            "Embassy 0.10 removes the need for a per-task stack. Each #[embassy_executor::task] expands to a static future whose size the compiler computes, and the executor polls whatever is ready. RAM per task is the size of its state machine, typically tens to a few hundred bytes, and the linker fails the build if the statics do not fit - you cannot run out of task memory at runtime.",
            "A task suspends at an await point by returning Pending and registering a waker. The peripheral interrupt fires, calls wake, and the executor polls that one task again. That is why an async UART read costs nothing while it waits: no polling loop, no dedicated stack, no context switch."
          ]
        },
        {
          "h": "Spawner, statics and the task contract",
          "p": [
            "main is itself a task. The Spawner handed to it is a handle usable from any task or interrupt, and spawn returns Result because a task with pool_size = 1 can only be spawned once. Every task argument must be 'static: no references into main's stack, no borrowing a local buffer.",
            "This is the constraint that shapes Embassy code. Peripheral drivers hand out owned singletons, buffers are static or moved into tasks, and shared state is a static Mutex from embassy-sync rather than a reference. Fighting the 'static bound means your design has an ownership problem, not a framework problem."
          ],
          "code": "#![no_std]\n#![no_main]\n\nuse embassy_executor::Spawner;\nuse embassy_time::{Duration, Timer};\nuse {defmt_rtt as _, panic_probe as _};\n\n#[embassy_executor::main]\nasync fn main(spawner: Spawner) {\n    spawner.spawn(blink()).unwrap();\n    spawner.spawn(sample()).unwrap();\n}\n\n#[embassy_executor::task]\nasync fn blink() {\n    let mut on = false;\n    loop {\n        on = !on;\n        defmt::info!(\"led {}\", on);\n        Timer::after(Duration::from_millis(500)).await;\n    }\n}\n\n#[embassy_executor::task(pool_size = 2)]\nasync fn sample() {\n    loop {\n        Timer::after_millis(10).await;\n    }\n}",
          "tip": "pool_size = N is the compile-time concurrency budget for that task. It is the Embassy equivalent of an RTIC task queue, priced in RAM up front."
        },
        {
          "h": "Where the preemption went",
          "p": [
            "Thread-mode tasks are cooperative: a task that computes for 5 ms without awaiting delays every other thread-mode task by 5 ms. Embassy does not pretend otherwise. If you need hard preemption, run a second executor in interrupt mode with InterruptExecutor and give it a higher NVIC priority; then the high-priority executor preempts the low-priority one.",
            "The practical rule: keep thread-mode work short and put anything with a deadline either in an interrupt-mode executor or in a short ISR that signals a task. Embassy buys you readable concurrency, not a schedulability proof - the analysis is still yours."
          ],
          "list": [
            "Thread-mode executor: cooperative, lowest NVIC priority, sleeps with WFE when idle",
            "Interrupt-mode executor: own NVIC priority, preempts thread mode, use for deadlines",
            "Blocking HAL calls inside a task stall everything at that priority",
            "Long computations must be chunked with yield_now or moved to an interrupt executor"
          ]
        }
      ],
      "exercise": {
        "prompt": "Two Embassy tasks share a sample buffer: a producer that fills it every 10 ms and a consumer that drains it every 100 ms. Make the handoff safe without a heap and without blocking either task.",
        "starter": "use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;\nuse embassy_sync::channel::Channel;\n\nstatic CH: Channel<CriticalSectionRawMutex, u16, 8> = Channel::new();",
        "hint": "Use try_send in the producer so a full channel is a measured drop rather than a stall, and receive().await in the consumer. Report drops with an AtomicU32 counter.",
        "solution": "use core::sync::atomic::{AtomicU32, Ordering};\nuse embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;\nuse embassy_sync::channel::Channel;\nuse embassy_time::{Duration, Ticker};\n\nstatic CH: Channel<CriticalSectionRawMutex, u16, 8> = Channel::new();\nstatic DROPS: AtomicU32 = AtomicU32::new(0);\n\n#[embassy_executor::task]\nasync fn producer() {\n    let mut tick = Ticker::every(Duration::from_millis(10));\n    let mut n: u16 = 0;\n    loop {\n        tick.next().await;\n        n = n.wrapping_add(1);\n        if CH.try_send(n).is_err() {\n            DROPS.fetch_add(1, Ordering::Relaxed);\n        }\n    }\n}\n\n#[embassy_executor::task]\nasync fn consumer() {\n    loop {\n        let v = CH.receive().await;\n        defmt::info!(\"sample {} drops {}\", v, DROPS.load(Ordering::Relaxed));\n        // batch here rather than per sample if the radio is slow\n    }\n}"
      },
      "questions": [
        {
          "q": "Where does an Embassy task's memory come from?",
          "options": [
            "A heap allocation at spawn time",
            "A per-task stack assigned by the linker script",
            "A static future sized at compile time, with the build failing if RAM is insufficient",
            "The caller's stack frame for the duration of the spawn"
          ],
          "answer": 2,
          "explain": "Task state lives in statics computed by the macro. Oversubscription is a link-time error, so \"out of memory at runtime\" is not a failure mode."
        },
        {
          "q": "A thread-mode task runs a 5 ms busy loop without awaiting. What is the consequence?",
          "options": [
            "Nothing, the executor load-balances across cores",
            "Every other thread-mode task is delayed by up to 5 ms",
            "The task is preempted by the executor automatically",
            "The executor panics on starvation"
          ],
          "answer": 1,
          "explain": "Thread-mode tasks are cooperative. Only an interrupt-mode executor or a hardware ISR can preempt, so long computations must be chunked or relocated."
        }
      ],
      "quickbytes": [
        "Every task argument is 'static: pass owned state, not references into main.",
        "spawn returns Result - pool_size and singleton tasks make double-spawn a handled error.",
        "Use try_send + a drop counter for telemetry; receive().await for the consumer.",
        "Need preemption? InterruptExecutor at a higher NVIC priority, not a longer task."
      ],
      "production": [
        "Task memory is reviewed from the map file, not estimated; the link fails loudly if it does not fit.",
        "Every channel capacity has a measured burst justification and a drop counter.",
        "No blocking HAL call appears inside an async task without a comment explaining the bound.",
        "Deadline-critical work runs in an interrupt-mode executor or a short ISR."
      ],
      "crates": [
        "embassy-executor",
        "embassy-time",
        "embassy-sync",
        "embassy-stm32"
      ],
      "github": [
        {
          "name": "embassy-rs/embassy - executor, time, HALs",
          "url": "https://github.com/embassy-rs/embassy"
        }
      ],
      "pitfall": "Calling a blocking sensor read inside a thread-mode task. The executor cannot poll anything else, and the 100 ms you spent waiting is added to every other task's latency.",
      "resources": [
        {
          "title": "Embassy book: executor model and task spawning",
          "url": "https://embassy.dev/book/",
          "kind": "docs"
        },
        {
          "title": "embassy-executor 0.10 API and feature flags",
          "url": "https://docs.rs/embassy-executor/latest/embassy_executor/",
          "kind": "docs"
        },
        {
          "title": "embassy-sync: channels, signals, mutexes",
          "url": "https://docs.rs/embassy-sync/latest/embassy_sync/",
          "kind": "docs"
        },
        {
          "title": "embassy stm32f4 examples: runnable firmware skeletons",
          "url": "https://github.com/embassy-rs/embassy/tree/main/examples/stm32f4",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x07",
      "n": 7,
      "title": "Timers and monotonic clocks: ticks, drift, deadlines",
      "minutes": 85,
      "level": "advanced",
      "goal": "Pick a timebase, compute its wrap and resolution, and build delays and timeouts that do not drift away from wall-clock time.",
      "sections": [
        {
          "h": "A tick rate is a trade-off, not a constant",
          "p": [
            "SysTick is a 24-bit down-counter clocked from the core or an external reference. At 1 kHz it wraps every 4.6 hours; at 1 MHz, every 16.8 seconds. The counter width sets how often software must service the wrap, and the tick rate sets both resolution and interrupt load: 1 kHz costs 1000 wake-ups per second even when nothing needs to happen.",
            "That is why a decent timebase is not SysTick at 1 kHz. Use a free-running 32-bit timer at 1 MHz and extend it in software to 64 bits, so you get microsecond resolution, a 71-minute hardware wrap handled cheaply, and no periodic interrupt at all. embassy-time and rtic-monotonics both build on this idea."
          ]
        },
        {
          "h": "Delay, period and deadline are different things",
          "p": [
            "Timer::after(d) waits d from now. A Ticker::every(d) yields on a fixed grid anchored at construction, so a slow body does not accumulate drift - if you overrun, it catches up or reports a missed tick, depending on configuration. Building a 1 Hz loop from Timer::after(1 s) at the end of the body means your clock runs slow by exactly the body duration every iteration.",
            "For deadlines, use an absolute instant, not a chain of relative delays. Convert the deadline to an Instant once, then compute the remaining duration each iteration. Relative sleeps inside a loop are how a 60-second watchdog becomes a 74-second watchdog."
          ],
          "code": "use embassy_time::{Duration, Instant, Ticker, Timer};\n\nasync fn fixed_rate() {\n    let mut tick = Ticker::every(Duration::from_secs(1));\n    loop {\n        tick.next().await; // grid-anchored: no accumulation of drift\n        // do work that takes less than 1 s\n    }\n}\n\nasync fn absolute_deadline() {\n    let deadline = Instant::now() + Duration::from_millis(250);\n    loop {\n        let left = deadline.saturating_duration_since(Instant::now());\n        if left == Duration::from_ticks(0) {\n            break;\n        }\n        Timer::after(left.min(Duration::from_millis(10))).await;\n    }\n}",
          "tip": "A relative sleep at the end of a loop adds the loop body to the period. Anchor on a ticker or an absolute instant instead."
        },
        {
          "h": "RTIC monotonic and the fugit types",
          "p": [
            "rtic-monotonics 3.0 provides the timebase that async RTIC tasks await on. The systick_monotonic! macro generates a type with a start method, an interrupt handler, and implementations of the delay traits. Because it ticks at a constant rate, it is convenient but not the lowest-power option - the crate says so itself.",
            "The returned instants are fugit types: a u64 count plus a rate, so conversions are checked at compile time. That prevents the classic bug of mixing milliseconds from one API with microseconds from another, which usually shows up as a delay a thousand times too short."
          ],
          "code": "use rtic_monotonics::systick::prelude::*;\n\nsystick_monotonic!(Mono, 1_000); // 1 kHz tick rate\n\nfn init() {\n    let cp = cortex_m::Peripherals::take().unwrap();\n    Mono::start(cp.SYST, 12_000_000); // core clock 12 MHz\n}\n\nasync fn control_loop() {\n    loop {\n        let t0 = Mono::now();\n        // ... work ...\n        let budget = 20.millis();\n        let elapsed = Mono::now() - t0;\n        if elapsed < budget {\n            Mono::delay(budget - elapsed).await;\n        } else {\n            defmt::warn!(\"overran by {:?}\", elapsed);\n        }\n    }\n}"
        }
      ],
      "exercise": {
        "prompt": "A loop must run every 10 ms, and each iteration takes 3 ms of work. Write it so the period stays 10 ms, count missed deadlines, and never sleep a negative duration.",
        "starter": "async fn run() {\n    loop {\n        work().await; // 3 ms\n        // TODO: keep a 10 ms period\n    }\n}",
        "hint": "Use a Ticker::every(10 ms) before the work, or track next = Instant::now() + 10 ms and sleep saturating_duration_since(now). Compare Instant::now() with next to count overruns.",
        "solution": "use core::sync::atomic::{AtomicU32, Ordering};\nuse embassy_time::{Duration, Instant, Timer};\n\nstatic OVERRUNS: AtomicU32 = AtomicU32::new(0);\nconst PERIOD: Duration = Duration::from_millis(10);\n\nasync fn run() {\n    let mut next = Instant::now();\n    loop {\n        next += PERIOD;\n\n        work().await;\n\n        let now = Instant::now();\n        if now > next {\n            // deadline missed: count it and resynchronise the grid\n            OVERRUNS.fetch_add(1, Ordering::Relaxed);\n            next = now + PERIOD;\n        } else {\n            Timer::after(next - now).await;\n        }\n    }\n}\n\nasync fn work() {\n    Timer::after_millis(3).await;\n}"
      },
      "questions": [
        {
          "q": "Why is a free-running 32-bit timer at 1 MHz often better than SysTick at 1 kHz?",
          "options": [
            "It uses less flash",
            "It gives microsecond resolution without a periodic interrupt, and the 71-minute wrap is handled in software",
            "It cannot be preempted by interrupts",
            "It removes the need for a monotonic wrapper"
          ],
          "answer": 1,
          "explain": "No periodic tick means no idle wake-ups, and 1 MHz gives 1 us resolution. The trade-off is that software must extend the counter past its 32-bit wrap."
        },
        {
          "q": "A control loop sleeps 10 ms at the end of each iteration and the body takes 3 ms. What is the period?",
          "options": [
            "10 ms",
            "13 ms",
            "7 ms",
            "It varies with CPU load"
          ],
          "answer": 1,
          "explain": "Relative sleeps compose: body plus sleep. Anchor on an absolute instant or a ticker to keep a 10 ms grid."
        }
      ],
      "quickbytes": [
        "Ticker::every gives a fixed grid; Timer::after at the end of a loop accumulates drift.",
        "Compute remaining time with saturating_duration_since; never subtract unsigned instants that may already have passed.",
        "Every watchdog and protocol timeout belongs to an absolute deadline, not a chain of sleeps.",
        "RC oscillators drift percent-level; never derive UART baud or RF timing from an uncalibrated internal clock."
      ],
      "production": [
        "The timebase, its resolution and its wrap period are documented next to the clock configuration.",
        "Loop periods are enforced against absolute instants, with an overrun counter exported in telemetry.",
        "Low-power modes account for every timer that stays running and its current draw.",
        "Timeout values are derived from worst-case measurement plus margin, not from round numbers."
      ],
      "crates": [
        "embassy-time",
        "rtic-monotonics",
        "cortex-m"
      ],
      "github": [
        {
          "name": "embassy-rs/embassy - embassy-time timebase",
          "url": "https://github.com/embassy-rs/embassy/tree/main/embassy-time"
        }
      ],
      "pitfall": "Chaining Timer::after(1 s) at the end of a loop whose body takes 80 ms: the loop period becomes 1.08 s and every timestamp you publish drifts by 8 percent.",
      "resources": [
        {
          "title": "embassy-time: Timer, Ticker, Instant, with_timeout",
          "url": "https://docs.rs/embassy-time/latest/embassy_time/",
          "kind": "docs"
        },
        {
          "title": "rtic-monotonics: timebases for RTIC async tasks",
          "url": "https://docs.rs/rtic-monotonics/latest/rtic_monotonics/",
          "kind": "docs"
        },
        {
          "title": "Embassy book: time and timers",
          "url": "https://embassy.dev/book/",
          "kind": "docs"
        },
        {
          "title": "embassy-time source: tickless time driver design",
          "url": "https://github.com/embassy-rs/embassy/tree/main/embassy-time",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x08",
      "n": 8,
      "title": "GPIO: pin typestate, electrical limits, debouncing",
      "minutes": 70,
      "level": "core",
      "goal": "Configure pins safely through the HAL typestate, respect drive limits, and debounce a button without blocking the loop.",
      "sections": [
        {
          "h": "Pins are types, not numbers",
          "p": [
            "A HAL returns a pin in a mode-specific type: Pin<'A', 5, Input> or Pin<'A', 5, Output>. Converting modes consumes the old value, so a pin cannot be simultaneously configured as an output and read as an input by mistake. The lifetime parameter prevents a pin from outliving the peripheral singleton that owns it.",
            "That is the whole point of the typestate: misconfiguration becomes a compile error. The cost is that peripheral structs are verbose in signatures, so most code stores them in a driver struct or passes them to a task at startup rather than threading generics everywhere."
          ],
          "code": "use embassy_stm32::gpio::{Input, Level, Output, Pull, Speed};\nuse embassy_stm32::Peripherals;\n\nfn setup(p: Peripherals) {\n    let mut led = Output::new(p.PA5, Level::Low, Speed::Low);\n    led.set_high();\n    led.toggle();\n\n    // active-low button with an internal pull-up\n    let button = Input::new(p.PC13, Pull::Up);\n    let _ = (led, button);\n}"
        },
        {
          "h": "The datasheet limits are real",
          "p": [
            "A GPIO pin sources or sinks a limited current - commonly 8 to 20 mA per pin, with a lower aggregate limit per port and a total for the package. An LED driven without a series resistor will work on the bench and degrade the driver over months. Size the resistor from the actual forward voltage: R = (Vdd - Vf) / I, then check the port total.",
            "Floating inputs are the other classic. A CMOS input with no defined level draws cross-conduction current in the input stage, which can be microamps per pin and ruin a sleep budget. Configure unused pins as analog or as outputs driving a known level, and enable pull-ups or pull-downs deliberately."
          ],
          "list": [
            "Series resistor for every LED: (Vdd - Vf) / I, rounded up, plus check port total",
            "Unused pins: analog mode or output-low, never floating",
            "Open-drain output for shared lines; pull-up value sets rise time",
            "Debounce in firmware only after the hardware RC has been considered"
          ]
        },
        {
          "h": "Debounce without blocking",
          "p": [
            "A mechanical contact bounces for 1 to 20 ms. Blocking delay(10 ms) after an edge is the usual first attempt, and it stalls everything at that priority. Better: timestamp the edge in the ISR, then re-read the pin once after the bounce window in a low-priority task, and only then accept the new state.",
            "If the button has to work in a sleep-heavy design, use the EXTI line to wake the MCU and do the debounce confirmation after wake, keeping the pin configured as a wake source with a pull resistor so the line does not float while asleep."
          ],
          "code": "use embassy_time::{Duration, Instant};\n\n#[derive(Default)]\npub struct Debounce {\n    last_edge: Option<Instant>,\n    stable: bool,\n}\n\nimpl Debounce {\n    const WINDOW: Duration = Duration::from_millis(15);\n\n    /// Call on every edge; returns Some(state) once the input has settled.\n    pub fn on_edge(&mut self, level_high: bool, now: Instant) -> Option<bool> {\n        match self.last_edge {\n            Some(t) if now - t < Self::WINDOW => {\n                self.last_edge = Some(now); // still bouncing, restart the window\n                None\n            }\n            _ => {\n                self.last_edge = None;\n                if self.stable != level_high {\n                    self.stable = level_high;\n                    Some(level_high)\n                } else {\n                    None\n                }\n            }\n        }\n    }\n}",
          "tip": "Keep the debounce logic pure - level plus timestamp in, decision out - so it can be unit-tested on the host with a fake clock."
        }
      ],
      "exercise": {
        "prompt": "Implement a debouncer that emits exactly one event per press, given a stream of (level, timestamp) samples that includes a 10 ms bounce burst, and prove it with a host test.",
        "starter": "pub struct Debounce { /* ... */ }\n\nimpl Debounce {\n    pub fn sample(&mut self, high: bool, now: u32) -> Option<bool> {\n        todo!()\n    }\n}",
        "hint": "Store the last accepted level and the timestamp of the last change. Only accept a new level if it has been stable for at least 15 ms; reset the candidate timer whenever the raw level changes.",
        "solution": "pub struct Debounce {\n    stable: bool,\n    candidate: bool,\n    changed_at: u32,\n    initialized: bool,\n}\n\nimpl Debounce {\n    pub fn new(initial: bool) -> Self {\n        Self {\n            stable: initial,\n            candidate: initial,\n            changed_at: 0,\n            initialized: false,\n        }\n    }\n\n    /// Returns Some(new_level) on an accepted transition.\n    pub fn sample(&mut self, high: bool, now_ms: u32) -> Option<bool> {\n        if !self.initialized {\n            self.initialized = true;\n            self.stable = high;\n            self.candidate = high;\n            self.changed_at = now_ms;\n            return None;\n        }\n\n        if high != self.candidate {\n            self.candidate = high;\n            self.changed_at = now_ms;\n            return None; // raw level moved: restart the stable window\n        }\n\n        if self.candidate != self.stable && now_ms.wrapping_sub(self.changed_at) >= 15 {\n            self.stable = self.candidate;\n            return Some(self.stable);\n        }\n        None\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn one_event_per_press_despite_bounce() {\n        let mut d = Debounce::new(false);\n        let _ = d.sample(false, 0);\n        // bounce burst between 100 and 110 ms\n        for (i, t) in [100u32, 102, 104, 106, 108, 110].iter().enumerate() {\n            assert_eq!(d.sample(i % 2 == 0, *t), None);\n        }\n        assert_eq!(d.sample(true, 126), Some(true));\n        assert_eq!(d.sample(true, 140), None);\n    }\n}"
      },
      "questions": [
        {
          "q": "Why does the HAL return a differently typed pin after into_push_pull_output()?",
          "options": [
            "To save flash by monomorphising fewer functions",
            "So mode misuse becomes a compile error and the old configuration cannot be reused",
            "Because GPIO registers differ per mode at runtime",
            "To allow the pin to be used from multiple tasks"
          ],
          "answer": 1,
          "explain": "Typestate encodes the mode in the type. The conversion consumes the old pin, so you cannot hold an input handle and write to it as an output."
        },
        {
          "q": "What is the cheapest correct way to stop an unused pin from wasting current?",
          "options": [
            "Enable its internal pull-up",
            "Leave it floating so the hardware defaults apply",
            "Configure it as analog or drive it to a known level",
            "Set it as an open-drain output high"
          ],
          "answer": 2,
          "explain": "A floating CMOS input can draw cross-conduction current. Analog mode disconnects the digital input; a driven output also defines the level."
        }
      ],
      "quickbytes": [
        "Output::new / into_push_pull_output consume the pin: mode changes are moves, not mutations.",
        "Size LED resistors from (Vdd - Vf)/I and check the per-port current total, not just the pin.",
        "Debounce with timestamps in a low-priority task; never delay() inside an ISR.",
        "Check whether the part has internal pull resistors strong enough for your switch before adding BOM parts."
      ],
      "production": [
        "Every external pin has a documented direction, pull configuration and power-on state in a pin table.",
        "Unused pins are explicitly configured, so sleep current matches the measurement.",
        "Button handling is debounced with a tested pure function, not a delay in an ISR.",
        "Outputs that drive actuators default to the safe state on reset via hardware, not firmware."
      ],
      "crates": [
        "embedded-hal",
        "embassy-stm32",
        "stm32f4xx-hal"
      ],
      "github": [
        {
          "name": "embassy-rs/embassy - GPIO typestate implementation",
          "url": "https://github.com/embassy-rs/embassy"
        }
      ],
      "pitfall": "Leaving unused pins floating. The board works, but sleep current is hundreds of microamps above the budget and the cause is invisible on a schematic review.",
      "resources": [
        {
          "title": "embedded-hal digital traits: InputPin, OutputPin, StatefulOutputPin",
          "url": "https://docs.rs/embedded-hal/latest/embedded_hal/digital/index.html",
          "kind": "docs"
        },
        {
          "title": "embassy-stm32 gpio module: Output, Input, Pull, Speed",
          "url": "https://docs.rs/embassy-stm32/latest/embassy_stm32/gpio/index.html",
          "kind": "docs"
        },
        {
          "title": "The Embedded Rust Book: GPIO and typestate",
          "url": "https://github.com/rust-embedded/book",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x09",
      "n": 9,
      "title": "I2C: transactions, NACKs and bus recovery",
      "minutes": 90,
      "level": "advanced",
      "goal": "Read a sensor over I2C with the right framing, decode its error kinds, and recover a bus stuck low without power-cycling the board.",
      "sections": [
        {
          "h": "A transaction is the unit of correctness",
          "p": [
            "I2C register reads are two operations in one frame: write the register pointer, then a repeated START, then read N bytes. Splitting that into write() followed by read() gives another master a window to interleave, and on many peripherals the second call issues a STOP and a fresh START, which some devices treat as a new transaction and reset the pointer.",
            "Addressing is 7-bit for almost every sensor, with the eighth bit as read/write. Ten-bit addressing exists but is rare outside EEPROMs. Broadcast address 0x00 is reserved, and a device that does not acknowledge its address is either absent, strapped differently, or holding SDA low."
          ],
          "code": "use embedded_hal::i2c::{I2c, Operation};\n\nfn read_reg<I: I2c>(i2c: &mut I, addr: u8, reg: u8, out: &mut [u8]) -> Result<(), I::Error> {\n    // write pointer + repeated START + read, in one transaction\n    i2c.transaction(addr, &mut [Operation::Write(&[reg]), Operation::Read(out)])\n}",
          "tip": "If a driver takes two separate I2C calls for one register read, it will fail intermittently on a bus with more than one master."
        },
        {
          "h": "Reading the error, not just the Err",
          "p": [
            "embedded-hal models I2C failures with ErrorKind. Bus means a protocol-level fault such as a stuck line; ArbitrationLoss means another master won and you must retry the whole frame; NoAcknowledge with source Address means nobody is at that address, while source Data means the device rejected the byte - often a write-protected register or an out-of-range pointer.",
            "These are not interchangeable. A NACK on data will never succeed on retry, so retrying burns your watchdog budget for nothing. An arbitration loss always needs a full-frame retry. Map the kind to a policy at the driver boundary and log the decision once, rather than sprinkling retry loops through the code."
          ],
          "list": [
            "NACK/address: check wiring and strapping, do not retry blindly",
            "NACK/data: register rejected the write; check the datasheet sequence",
            "ArbitrationLoss: retry the entire transaction, not just the read",
            "Bus/Overrun: recover the peripheral, and for a stuck line, recover the bus"
          ],
          "code": "use embedded_hal::i2c::{ErrorKind, NoAcknowledgeSource};\n\nfn policy(kind: ErrorKind) -> &'static str {\n    match kind {\n        ErrorKind::ArbitrationLoss => \"retry whole frame\",\n        ErrorKind::NoAcknowledge(NoAcknowledgeSource::Address) => \"device absent: check wiring\",\n        ErrorKind::NoAcknowledge(NoAcknowledgeSource::Data) => \"rejected: check register\",\n        ErrorKind::Bus => \"bus fault: recover lines\",\n        ErrorKind::Overrun => \"peripheral overrun: reinit\",\n        _ => \"unknown\",\n    }\n}"
        },
        {
          "h": "When the bus is stuck low",
          "p": [
            "A slave can be left mid-byte holding SDA low, typically after the MCU resets while a transfer was in flight. The bus is then dead: every START looks like a data transition and nothing acknowledges. The fix is to clock the slave out of it - switch SCL to a GPIO output, pulse it up to nine times until SDA releases, issue a manual STOP, then reinitialise the peripheral.",
            "Two electrical facts make this rarer. Pull-up sizing must meet the rise-time spec for your bus capacitance: with 100 pF and Fast mode's 300 ns limit, 3.3 kOhm is about right, while 10 kOhm is marginal. And a series resistor or an I2C isolator protects against a slave that latches up and holds the line during power sequencing."
          ],
          "code": "/// Clock a stuck slave free: up to 9 SCL pulses until it releases SDA.\n/// Returns Ok(true) when the line is free, Ok(false) when it is still held.\nfn recover_bus(\n    scl: &mut impl embedded_hal::digital::OutputPin,\n    sda: &mut impl embedded_hal::digital::InputPin,\n) -> Result<bool, ()> {\n    for _ in 0..9 {\n        if sda.is_high().map_err(|_| ())? {\n            return Ok(true); // slave finished its byte and let go\n        }\n        scl.set_high().map_err(|_| ())?;\n        cortex_m::asm::delay(160); // ~10 kHz at 16 MHz\n        scl.set_low().map_err(|_| ())?;\n        cortex_m::asm::delay(160);\n    }\n    // Still held: check the pull-ups and the slave power, or reconfigure both\n    // pins as open-drain outputs and drive a manual STOP.\n    Ok(false)\n}"
        }
      ],
      "exercise": {
        "prompt": "Write read_temp that retries only on arbitration loss (3 attempts), maps a NACK to a permanent error, and calls the bus recovery hook on ErrorKind::Bus before returning.",
        "starter": "pub enum SensorError {\n    Transient,\n    Absent,\n    BusFault,\n}\n\npub fn read_temp<I: embedded_hal::i2c::I2c>(i2c: &mut I, addr: u8) -> Result<f32, SensorError> {\n    todo!()\n}",
        "hint": "Match on embedded_hal::i2c::ErrorKind through a helper that converts I::Error to ErrorKind (I2c trait exposes Error: Error, so use .kind()). Retry ArbitrationLoss in a loop of 3; convert NoAcknowledge to Absent; Bus to BusFault after trying recovery.",
        "solution": "use embedded_hal::i2c::{ErrorKind, I2c, Operation};\n\npub enum SensorError {\n    Transient,\n    Absent,\n    BusFault,\n}\n\nfn classify<E: embedded_hal::i2c::Error>(e: E) -> ErrorKind {\n    e.kind()\n}\n\npub fn read_temp<I: I2c>(i2c: &mut I, addr: u8) -> Result<f32, SensorError> {\n    let mut attempt = 0;\n    loop {\n        attempt += 1;\n        let mut buf = [0u8; 2];\n        let ops = &mut [Operation::Write(&[0x05]), Operation::Read(&mut buf)];\n        match i2c.transaction(addr, ops) {\n            Ok(()) => {\n                let raw = i16::from_be_bytes(buf);\n                return Ok(raw as f32 / 16.0);\n            }\n            Err(e) => match classify(e) {\n                ErrorKind::ArbitrationLoss if attempt < 3 => continue,\n                ErrorKind::ArbitrationLoss => return Err(SensorError::Transient),\n                ErrorKind::NoAcknowledge(_) => return Err(SensorError::Absent),\n                ErrorKind::Bus => {\n                    // call site owns the pins: signal that recovery is required\n                    return Err(SensorError::BusFault);\n                }\n                _ => return Err(SensorError::Transient),\n            },\n        }\n    }\n}"
      },
      "questions": [
        {
          "q": "Why must a register read be a single transaction rather than write() then read()?",
          "options": [
            "It halves the number of bytes on the bus",
            "It keeps the pointer write and the read in one repeated-START frame, immune to other masters interleaving",
            "Because I2C::read does not exist",
            "Because the peripheral cannot generate a second START"
          ],
          "answer": 1,
          "explain": "A transaction holds the bus across both operations. Two calls allow another master in between and may issue a STOP that resets the device pointer."
        },
        {
          "q": "A slave holds SDA low after the MCU resets. What is the standard recovery?",
          "options": [
            "Power-cycle the slave and re-run the init sequence",
            "Clock SCL up to nine times until SDA is released, then issue a STOP and reinit the peripheral",
            "Lower the pull-up resistance",
            "Switch to 10-bit addressing"
          ],
          "answer": 1,
          "explain": "The slave is mid-byte; extra clocks let it finish and release SDA. Then a manual STOP returns the bus to idle so the peripheral can be reinitialised."
        },
        {
          "q": "Which error should never be retried?",
          "options": [
            "ArbitrationLoss",
            "NoAcknowledge with source Data",
            "Bus",
            "Overrun"
          ],
          "answer": 1,
          "explain": "A data NACK is a deterministic rejection by the device - a protected register or a bad pointer. Retrying costs time and changes nothing."
        }
      ],
      "quickbytes": [
        "One transaction per register access: Operation::Write then Operation::Read in the same call.",
        "Map ErrorKind to a retry policy once, at the driver boundary; never retry a data NACK.",
        "Fast mode 400 kHz with 100 pF bus capacitance needs roughly 3.3 kOhm pull-ups for the 300 ns rise time.",
        "Log the first NACK with address and register; field failures are usually a strapping resistor."
      ],
      "production": [
        "Every I2C access has a bounded transaction count and a timeout owned by the caller.",
        "Bus-recovery is implemented and tested by pulling SDA low on the bench.",
        "Pull-up values are justified against measured bus capacitance for the chosen speed.",
        "Device addresses live in one place with the strapping configuration documented."
      ],
      "crates": [
        "embedded-hal",
        "embedded-hal-async",
        "embassy-stm32"
      ],
      "github": [
        {
          "name": "rust-embedded/embedded-hal - i2c traits and error kinds",
          "url": "https://github.com/rust-embedded/embedded-hal"
        }
      ],
      "pitfall": "Sharing an I2C bus across two tasks with a blocking driver in one and an async driver in the other. The bus object is not Sync, and the borrow checker is the last thing that tells you.",
      "resources": [
        {
          "title": "embedded-hal i2c module: I2c, Operation, ErrorKind",
          "url": "https://docs.rs/embedded-hal/latest/embedded_hal/i2c/index.html",
          "kind": "docs"
        },
        {
          "title": "embassy-stm32 i2c: async and blocking drivers",
          "url": "https://docs.rs/embassy-stm32/latest/embassy_stm32/i2c/index.html",
          "kind": "docs"
        },
        {
          "title": "embedded-hal-bus: sharing one bus between devices",
          "url": "https://docs.rs/embedded-hal-bus/latest/embedded_hal_bus/",
          "kind": "docs"
        },
        {
          "title": "embedded-hal source: i2c trait and error kinds",
          "url": "https://github.com/rust-embedded/embedded-hal",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x10",
      "n": 10,
      "title": "SPI: modes, chip select, and full-duplex framing",
      "minutes": 80,
      "level": "advanced",
      "goal": "Match a device's SPI mode and chip-select timing, use SpiDevice for framing, and avoid the classic half-duplex read bug.",
      "sections": [
        {
          "h": "Four modes, one correct answer",
          "p": [
            "CPOL sets the idle clock level; CPHA sets whether data is sampled on the first or second edge. Their product gives modes 0 through 3, and a device works in exactly one of them - some support two. Get it wrong and you read shifted data that looks like plausible garbage: a temperature of 4194 degrees rather than an error.",
            "The datasheet states the mode as a timing diagram, not always as a number. Read tSU/tH for data setup and hold, and the maximum clock, then derive the HAL setting from the diagram rather than from a sibling driver you found online."
          ],
          "code": "// SPI mode 0: CPOL=0 (idle low), CPHA=0 (sample on first/rising edge)\n// STM32 HAL expresses this as Mode { polarity: IdleLow, phase: CaptureOnFirstTransition }\nlet spi = Spi::new(\n    p.SPI1,\n    p.SCK, p.MISO, p.MOSI,\n    p.DMA1_CH3, p.DMA1_CH2,\n    Hertz(1_000_000),\n    SpiConfig::default(),\n);"
        },
        {
          "h": "SpiBus is full duplex; reads need dummy bytes",
          "p": [
            "Every SPI transfer exchanges bytes in both directions simultaneously. Reading means clocking out something - usually 0x00 or 0xFF - while clocking the answer in. transfer_in_place takes one buffer and overwrites it with received data, which is the cheapest correct way to do a full-duplex exchange of equal length.",
            "Writing only is easy: write() clocks data out and ignores MISO. Reading only is the trap: read() clocks in bytes while driving MOSI low, which is fine for a pure read but breaks devices that interpret the outgoing byte as a command continuation."
          ],
          "tip": "If a read returns 0x00 or 0xFF for every byte, check chip select and mode before suspecting the sensor."
        },
        {
          "h": "Chip select is a timing requirement",
          "p": [
            "SpiDevice wraps a bus and drives a chip-select pin around a closure, so the CS assertion and deassertion bracket exactly one logical transaction. That matters when a device needs CS to stay low across a command byte and its data, and it prevents two drivers sharing a bus from interleaving mid-frame.",
            "Many devices specify a minimum CS-high time between transactions (tCSH) and a setup time before the first clock (tCSS). embedded-hal-bus's ExclusiveDevice takes a delay provider so you can meet those numbers in software when the peripheral does not do it in hardware."
          ],
          "code": "use embedded_hal_bus::spi::ExclusiveDevice;\nuse embedded_hal::spi::SpiDevice;\n\nlet bus = /* SpiBus from the HAL */;\nlet cs = /* OutputPin, active low */;\nlet delay = /* DelayNs implementation */;\nlet mut dev = ExclusiveDevice::new(bus, cs, delay).unwrap();\n\ndev.transaction(|bus| {\n    bus.write(&[0x80 | 0x0F])?;          // command: read register 0x0F\n    let mut v = [0u8; 1];\n    bus.read(&mut v)?;                     // clocked in with CS still low\n    Ok(v[0])\n}).unwrap();"
        }
      ],
      "exercise": {
        "prompt": "Implement read_register for a device that needs the command byte, a one-byte turnaround, then two data bytes - all inside one CS assertion - and return a u16.",
        "starter": "pub fn read_register<D: embedded_hal::spi::SpiDevice>(dev: &mut D, reg: u8) -> Result<u16, D::Error> {\n    todo!()\n}",
        "hint": "Use dev.transaction(|bus| { ... }) and inside it write the command, write one dummy byte, then transfer_in_place a two-byte buffer (or read into it). Keep every step inside the closure so CS stays asserted.",
        "solution": "use embedded_hal::spi::SpiDevice;\n\npub fn read_register<D: SpiDevice>(dev: &mut D, reg: u8) -> Result<u16, D::Error> {\n    dev.transaction(|bus| {\n        bus.write(&[reg | 0x80])?; // command with read bit\n        bus.write(&[0x00])?;       // turnaround byte\n        let mut buf = [0u8; 2];\n        bus.transfer_in_place(&mut buf)?;\n        Ok(u16::from_be_bytes(buf))\n    })\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    use embedded_hal::spi::{ErrorType, Operation, SpiBus};\n\n    struct FakeBus;\n    impl ErrorType for FakeBus {\n        type Error = core::convert::Infallible;\n    }\n    impl SpiBus for FakeBus {\n        fn read(&mut self, buf: &mut [u8]) -> Result<(), Self::Error> {\n            buf.copy_from_slice(&[0x12, 0x34]);\n            Ok(())\n        }\n        fn write(&mut self, _w: &[u8]) -> Result<(), Self::Error> { Ok(()) }\n        fn transfer(&mut self, _r: &mut [u8], _w: &[u8]) -> Result<(), Self::Error> { Ok(()) }\n        fn transfer_in_place(&mut self, buf: &mut [u8]) -> Result<(), Self::Error> {\n            buf.copy_from_slice(&[0x12, 0x34]);\n            Ok(())\n        }\n        fn flush(&mut self) -> Result<(), Self::Error> { Ok(()) }\n    }\n\n    struct Dev(FakeBus);\n    impl ErrorType for Dev {\n        type Error = core::convert::Infallible;\n        type Bus = FakeBus;\n    }\n    impl SpiDevice for Dev {\n        fn transaction<T, E, F>(&mut self, f: F) -> Result<T, Self::Error>\n        where\n            F: FnOnce(&mut Self::Bus) -> Result<T, E>,\n            E: From<Self::Error>,\n        {\n            f(&mut self.0).map_err(|_| unreachable!())\n        }\n    }\n\n    #[test]\n    fn reads_big_endian() {\n        let mut d = Dev(FakeBus);\n        assert_eq!(read_register(&mut d, 0x0F).unwrap(), 0x1234);\n    }\n}"
      },
      "questions": [
        {
          "q": "A device datasheet specifies mode 3. What do CPOL and CPHA mean?",
          "options": [
            "Clock idles high; data sampled on the second edge",
            "Clock idles low; data sampled on the first edge",
            "Clock idles high; data sampled on the first edge",
            "Clock idles low; data sampled on the second edge"
          ],
          "answer": 0,
          "explain": "Mode 3 is CPOL=1, CPHA=1: idle-high clock, with sampling on the second (falling) edge. Modes 0 and 3 cover most parts."
        },
        {
          "q": "Why does reading over SPI require sending bytes?",
          "options": [
            "The peripheral needs a start byte",
            "SPI is full duplex: the clock only runs while bytes are exchanged, so reads are always paired with dummy writes",
            "Chip select must be toggled per byte",
            "MISO is open-drain and needs a pull-up drive"
          ],
          "answer": 1,
          "explain": "There is no read-only transaction on the wire. You clock out a dummy value and capture MISO into the same buffer with transfer_in_place."
        }
      ],
      "quickbytes": [
        "Derive the mode from the timing diagram; shifted data usually means CPHA is wrong.",
        "Wrap a shared bus in ExclusiveDevice and do the whole frame inside one transaction closure.",
        "Check tCSS and tCSH: some parts need chip select held low across command and data.",
        "Lower the clock before lengthening wires - 1 MHz on a ribbon cable fails where 8 MHz on a 5 cm trace works."
      ],
      "production": [
        "SPI mode, clock rate and CS timing are recorded with the datasheet figure they came from.",
        "Every device on a shared bus is a SpiDevice; no driver touches the raw bus.",
        "Signal integrity is validated on the real cable length at the real clock rate with a scope.",
        "A read returning all 0x00 or all 0xFF raises an explicit device-absent error rather than a plausible value."
      ],
      "crates": [
        "embedded-hal",
        "embedded-hal-bus",
        "embassy-stm32"
      ],
      "github": [
        {
          "name": "rust-embedded/embedded-hal - SpiBus and SpiDevice traits",
          "url": "https://github.com/rust-embedded/embedded-hal"
        }
      ],
      "pitfall": "Holding CS low across two separate transaction calls. The device sees one long frame, misinterprets the second command, and the failure depends on timing.",
      "resources": [
        {
          "title": "embedded-hal spi module: SpiBus, SpiDevice",
          "url": "https://docs.rs/embedded-hal/latest/embedded_hal/spi/index.html",
          "kind": "docs"
        },
        {
          "title": "embedded-hal-bus: ExclusiveDevice and shared buses",
          "url": "https://docs.rs/embedded-hal-bus/latest/embedded_hal_bus/spi/index.html",
          "kind": "docs"
        },
        {
          "title": "The Embedded Rust Book: SPI and device abstraction",
          "url": "https://github.com/rust-embedded/book",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x11",
      "n": 11,
      "title": "UART: framing, ring buffers and backpressure",
      "minutes": 85,
      "level": "advanced",
      "goal": "Move bytes over UART without dropping them: correct framing, interrupt or DMA receive paths, and a buffer policy for when the consumer is slow.",
      "sections": [
        {
          "h": "Framing and the error budget",
          "p": [
            "8N1 - eight data bits, no parity, one stop bit - is the default for a reason: it is what most bootloaders and log consoles assume. The receiver samples mid-bit; with a 10-bit frame, a baud error above roughly 2 percent at either end starts corrupting the last bits. Internal RC oscillators are specified at percent-level accuracy over temperature, which is why a crystal or a calibrated clock is mandatory above 115200 baud.",
            "Framing errors, parity errors and overruns are distinct flags. Overrun means the receive register was not read before the next byte arrived - a software timing problem, not an electrical one, and the most common cause of \"randomly missing bytes\"."
          ]
        },
        {
          "h": "The ISR should only move bytes",
          "p": [
            "The pattern that scales is a single-producer single-consumer ring: the RX interrupt pushes bytes into a heapless queue and returns; a task drains it at its own pace. The ISR then costs a few hundred nanoseconds regardless of protocol logic, so it never delays higher-priority work.",
            "When the queue is full you have three honest options: drop the newest byte and count it, drop the oldest byte, or assert flow control. Counting drops is not optional - an unexplained CRC failure three layers up is usually a UART drop three layers down."
          ],
          "code": "use heapless::spsc::{Producer, Queue};\n\nstatic mut RX_Q: Queue<u8, 256> = Queue::new();\n\n// In the real firmware the queue lives in a static Mutex or is split\n// once in init; this shows the data path.\nfn rx_isr(p: &mut Producer<'static, u8>, byte: u8, drops: &core::sync::atomic::AtomicU32) {\n    if p.enqueue(byte).is_err() {\n        drops.fetch_add(1, core::sync::atomic::Ordering::Relaxed);\n    }\n}",
          "tip": "Size the ring from the longest burst, not the average rate: 256 bytes at 115200 baud is only 22 ms of slack."
        },
        {
          "h": "DMA, idle detection, and embedded-io",
          "p": [
            "For sustained throughput, a DMA channel writes into a circular buffer and an idle-line or half-transfer interrupt tells you how much arrived. That removes per-byte interrupts entirely, at the price of cache maintenance if your core has a D-cache and of a buffer whose wrap-around you must account for. The practical win is not just CPU time: the receive path becomes immune to the jitter of a busy interrupt table, which is what makes high-rate links usable alongside a control loop.",
            "At the API level, portable async code uses embedded-io-async: Read and Write with an ErrorKind, write_all for framing, and flush where the transport buffers. Because it is a trait, the same protocol parser runs over UART, USB CDC or a socket on the host - which is exactly how you test it. Note that embedded-hal 1.0 no longer carries serial traits at all; embedded-io is the current home for byte streams, and the older Read/Write traits you find in blog posts are from a version that is gone."
          ],
          "list": [
            "Interrupt-per-byte: simplest, fine up to tens of kbaud with short ISRs",
            "DMA circular + idle interrupt: best for sustained or high-rate links",
            "Flow control (RTS/CTS) when the receiver genuinely cannot keep up",
            "RS-485 half duplex needs the DE pin toggled after the last byte leaves the shift register"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write a byte-oriented framing parser that reads length-prefixed frames (0xAA, length, payload, checksum) from a byte stream, rejects bad checksums, and resynchronises after garbage - without allocation.",
        "starter": "pub struct Parser { buf: [u8; 64], len: usize }\n\nimpl Parser {\n    /// Feed one byte; returns a frame slice when complete.\n    pub fn push(&mut self, b: u8) -> Option<&'_ [u8]> {\n        todo!()\n    }\n}",
        "hint": "Keep a state machine: waiting for 0xAA, then length, then payload+checksum. On any invalid length or checksum, reset to the search state and keep the byte if it was 0xAA. Return a slice into the internal buffer.",
        "solution": "pub struct Parser {\n    buf: [u8; 64],\n    len: usize,\n    expect: usize,\n    state: State,\n}\n\n#[derive(PartialEq)]\nenum State {\n    Idle,\n    Body,\n}\n\nimpl Parser {\n    pub const fn new() -> Self {\n        Self { buf: [0; 64], len: 0, expect: 0, state: State::Idle }\n    }\n\n    pub fn push(&mut self, b: u8) -> Option<&'_ [u8]> {\n        match self.state {\n            State::Idle => {\n                if b == 0xAA {\n                    self.buf[0] = b;\n                    self.len = 1;\n                    self.state = State::Body;\n                }\n                None\n            }\n            State::Body => {\n                if self.len == 1 {\n                    if b == 0 || b as usize > self.buf.len() - 3 {\n                        self.state = State::Idle; // implausible length: resync\n                        return None;\n                    }\n                    self.expect = 2 + b as usize; // length + payload\n                }\n                self.buf[self.len] = b;\n                self.len += 1;\n\n                if self.len == self.expect + 1 {\n                    let sum: u8 = self.buf[..self.len - 1].iter().fold(0u8, |a, x| a.wrapping_add(*x));\n                    let ok = sum == self.buf[self.len - 1];\n                    let frame_len = self.len;\n                    self.state = State::Idle;\n                    self.len = 0;\n                    if ok {\n                        return Some(&self.buf[1..frame_len - 1]);\n                    }\n                }\n                None\n            }\n        }\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn resyncs_after_garbage_and_checksum_error() {\n        let mut p = Parser::new();\n        for b in [0x00, 0xFF, 0xAA, 0x02, 0x10, 0x20, 0x00] {\n            assert!(p.push(b).is_none()); // bad checksum\n        }\n        let frame: [u8; 4] = [0xAA, 0x02, 0x10, 0x20];\n        let sum = 0xAAu8.wrapping_add(0x02).wrapping_add(0x10).wrapping_add(0x20);\n        let mut got = None;\n        for b in frame.iter().chain(core::iter::once(&sum)) {\n            if let Some(f) = p.push(*b) {\n                got = Some(f.to_vec());\n            }\n        }\n        assert_eq!(got.unwrap(), vec![0x10, 0x20]);\n    }\n}"
      },
      "questions": [
        {
          "q": "Bytes arrive but are occasionally missing, and the status register shows an overrun flag. What is the cause?",
          "options": [
            "Baud rate mismatch between the two ends",
            "The receive register was not serviced before the next byte arrived",
            "The stop bit is configured as two bits",
            "The ground connection is missing"
          ],
          "answer": 1,
          "explain": "Overrun is a software-timing failure: the ISR or DMA did not drain the data register in time. Fix it with a faster path or flow control, not a slower baud."
        },
        {
          "q": "Why can a 256-byte ring buffer be too small even at 115200 baud?",
          "options": [
            "Because UART always sends in 512-byte blocks",
            "Because 256 bytes is only about 22 ms of line time, so a slow consumer overruns quickly",
            "Because heapless queues have per-byte overhead",
            "Because the interrupt latency exceeds 20 ms"
          ],
          "answer": 1,
          "explain": "At 115200 baud, 10 bits per byte means roughly 11.5 kB/s - 256 bytes is ~22 ms. Size the buffer from the worst consumer stall, not the average rate."
        }
      ],
      "quickbytes": [
        "Keep the RX ISR to a queue push; all protocol logic belongs in a task.",
        "Count and export dropped bytes - silent drops become unexplained CRC failures later.",
        "Above 115200 baud, verify the clock source; RC oscillators drift past the 2 percent budget.",
        "embedded-io-async traits let the same parser run on UART, USB and a host-side socket in tests."
      ],
      "production": [
        "Baud error is computed from the actual clock tree, including the PLL, and stays under 2 percent.",
        "RX overrun and queue-full counters exist and are published in telemetry.",
        "The framing parser is a pure state machine tested on the host with garbage and truncation cases.",
        "RS-485 DE timing is verified on a scope for the last byte of the frame."
      ],
      "crates": [
        "embedded-io-async",
        "heapless",
        "embassy-stm32"
      ],
      "github": [
        {
          "name": "embassy-rs/embassy - UART with DMA and idle detection",
          "url": "https://github.com/embassy-rs/embassy"
        }
      ],
      "pitfall": "Printing log lines over the same UART that carries the protocol. Logging blocks, bytes interleave mid-frame, and the field device appears to have a protocol bug.",
      "resources": [
        {
          "title": "embedded-io-async: async Read and Write traits",
          "url": "https://docs.rs/embedded-io-async/latest/embedded_io_async/",
          "kind": "docs"
        },
        {
          "title": "embassy-stm32 usart: async, DMA and idle-line support",
          "url": "https://docs.rs/embassy-stm32/latest/embassy_stm32/usart/index.html",
          "kind": "docs"
        },
        {
          "title": "heapless spsc queue: the ISR-to-task handoff",
          "url": "https://docs.rs/heapless/latest/heapless/spsc/index.html",
          "kind": "docs"
        },
        {
          "title": "embassy-stm32 usart source: DMA and idle-line handling",
          "url": "https://github.com/embassy-rs/embassy",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x12",
      "n": 12,
      "title": "DMA: buffer ownership, alignment and cache",
      "minutes": 95,
      "level": "industry",
      "goal": "Move data with DMA while the CPU does real work, using ownership types and cache rules that make the transfer sound.",
      "sections": [
        {
          "h": "DMA is a borrow checker problem",
          "p": [
            "A DMA engine reads from memory the CPU can also write. If both touch a buffer during a transfer, you get exactly the aliasing bug Rust exists to prevent - except the compiler cannot see it, because the other writer is hardware. HALs model this with ownership: you hand the buffer to a Transfer, which takes it by value, and you get it back only when the transfer completes. During the transfer there is no safe way to name the buffer.",
            "That is why DMA APIs return a Result<Transfer, Error> from the start call and a (buffer, result) from the wait. If you find yourself calling unsafe to get the pointer back, the design is fighting you and the design is right."
          ],
          "list": [
            "Transfer takes the buffer; completion returns it - no use-after-free, no concurrent access",
            "The buffer must outlive the transfer; a stack local in a helper function will not do",
            "Peripheral and channel are also owned, preventing two transfers on one channel",
            "Errors must return the buffer too, or an error path leaks your only buffer"
          ]
        },
        {
          "h": "Alignment and cache are where it breaks",
          "p": [
            "Most DMA engines require the buffer address to be aligned to the transfer size - 4 bytes for a word-wide transfer - and some require it not to cross a 1 KB boundary. A [u8; 512] on the stack is not guaranteed to satisfy either. Use a #[repr(align(32))] wrapper or a static buffer with an explicit alignment attribute.",
            "On Cortex-M7 and other cached cores the second problem is worse: the CPU may have dirty cache lines covering the buffer, which the DMA engine never sees. Before a TX transfer you clean (write back) the buffer; after an RX transfer you invalidate it before reading. Cache lines are 32 bytes, so a buffer that shares a line with other data loses those writes on invalidate."
          ],
          "code": "#[repr(align(32))]\npub struct DmaBuf<const N: usize>([u8; N]);\n\nimpl<const N: usize> DmaBuf<N> {\n    pub const fn new() -> Self {\n        Self([0; N])\n    }\n    pub fn as_slice(&self) -> &[u8] { &self.0 }\n    pub fn as_mut_slice(&mut self) -> &mut [u8] { &mut self.0 }\n}\n\n// 32-byte alignment keeps a buffer from sharing a D-cache line with\n// unrelated data, which would be corrupted by an invalidate.\nstatic mut RX: DmaBuf<256> = DmaBuf::new();\n\n/// Sketch of the HAL surface: names differ per chip.\n/// Before TX: clean the cache range. After RX: invalidate it.\nfn tx_path<D>(dma: D, buf: DmaBuf<256>) {\n    // let transfer = dma.write(buf)?;  // buf moved in\n    // let (buf, res) = transfer.wait()?; // buf moved back out\n    let _ = (dma, buf);\n}",
          "tip": "Put DMA buffers in a dedicated, aligned static - never on the stack, never adjacent to state you care about."
        },
        {
          "h": "What DMA actually buys",
          "p": [
            "For a 512-byte SPI frame at 8 MHz, the CPU would spend about 512 microseconds bit-shuffling. With DMA it spends a few microseconds starting the transfer and can sleep or process the previous frame. The interrupt count also collapses: one completion interrupt instead of 512 byte interrupts, which matters more than the CPU cycles because each interrupt costs entry and exit latency.",
            "The cost is complexity and latency. A DMA transfer has setup overhead of a few microseconds, so it is a loss for 4-byte register reads. It also completes asynchronously, so your state machine must handle \"transfer in flight\" as a first-class state rather than assuming blocking semantics."
          ]
        }
      ],
      "exercise": {
        "prompt": "Model a double-buffered ADC capture: while DMA fills buffer A, the CPU processes buffer B, and a half-transfer interrupt swaps them. Write the state type and the swap function so neither side can see a partially filled buffer.",
        "starter": "pub struct Capture { a: [u16; 128], b: [u16; 128], active: usize }\n\nimpl Capture {\n    pub fn on_half(&mut self) { todo!() }\n    pub fn ready(&self) -> &[u16] { todo!() }\n}",
        "hint": "Keep an atomic index of the buffer that is being filled and one flag saying the other is complete. The ISR sets the flag and flips the index; the consumer clears the flag after processing.",
        "solution": "use core::sync::atomic::{AtomicBool, AtomicUsize, Ordering};\n\npub struct Capture {\n    bufs: [[u16; 128]; 2],\n    filling: AtomicUsize,\n    ready: AtomicBool,\n}\n\nimpl Capture {\n    pub const fn new() -> Self {\n        Self {\n            bufs: [[0; 128]; 2],\n            filling: AtomicUsize::new(0),\n            ready: AtomicBool::new(false),\n        }\n    }\n\n    /// Buffer the DMA is currently writing into.\n    pub fn dma_target(&self) -> &mut [u16; 128] {\n        let i = self.filling.load(Ordering::Relaxed);\n        // SAFETY: only the ISR flips `filling`, and it does so while\n        // the DMA is stopped between half-transfers.\n        unsafe { &mut *(&self.bufs[i] as *const [u16; 128] as *mut [u16; 128]) }\n    }\n\n    /// Half-transfer interrupt: the other buffer is now complete.\n    pub fn on_half(&self) {\n        self.ready.store(true, Ordering::Release);\n        let i = self.filling.load(Ordering::Relaxed);\n        self.filling.store(1 - i, Ordering::Relaxed);\n    }\n\n    /// Consumer: take the completed buffer, if there is one.\n    pub fn take(&self) -> Option<&[u16; 128]> {\n        if !self.ready.swap(false, Ordering::AcqRel) {\n            return None;\n        }\n        let i = 1 - self.filling.load(Ordering::Relaxed);\n        Some(&self.bufs[i])\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn swap_exposes_only_the_finished_buffer() {\n        let c = Capture::new();\n        assert!(c.take().is_none());\n        c.on_half();\n        assert!(c.take().is_some());\n        assert!(c.take().is_none());\n    }\n}"
      },
      "questions": [
        {
          "q": "Why does a HAL take the buffer by value when starting a DMA transfer?",
          "options": [
            "To copy it into a hardware FIFO",
            "So the CPU cannot legally touch memory the DMA is reading or writing",
            "Because DMA requires heap allocation",
            "To let the compiler vectorise the copy"
          ],
          "answer": 1,
          "explain": "Ownership encodes the exclusivity that the borrow checker cannot infer for a hardware writer. The buffer returns on completion, restoring safe access."
        },
        {
          "q": "On a Cortex-M7, when must you clean the D-cache?",
          "options": [
            "After every RX transfer completes",
            "Before a DMA read of memory the CPU has written",
            "Only when the MPU is enabled",
            "Never; DMA bypasses the cache by hardware design"
          ],
          "answer": 1,
          "explain": "Clean = write dirty lines out to SRAM, so the DMA engine sees them. For RX you invalidate after the transfer instead, before the CPU reads."
        },
        {
          "q": "When is DMA the wrong choice?",
          "options": [
            "For a 512-byte SPI frame at 8 MHz",
            "For a single 4-byte register read, where setup costs more than the transfer",
            "For ADC sampling at 100 kHz",
            "For UART receive at 921600 baud"
          ],
          "answer": 1,
          "explain": "Setup overhead is microseconds; a 4-byte transfer takes less. DMA wins with volume or with the need to free the CPU at exact times."
        }
      ],
      "quickbytes": [
        "DMA buffers live in aligned statics, never on the stack.",
        "Clean before TX, invalidate after RX, and keep buffers 32-byte aligned on cached cores.",
        "Export an in-flight state; DMA completion is asynchronous and you will otherwise read stale data.",
        "One completion interrupt instead of N byte interrupts is often the bigger win than raw CPU cycles."
      ],
      "production": [
        "Every DMA buffer is a named static with explicit alignment and documented ownership.",
        "Cache maintenance is applied at the exact boundaries and reviewed against the core's line size.",
        "Transfer error paths return the buffer, so no code path can leak the only buffer of a pool.",
        "DMA and interrupt priority interactions are verified under load, with no missed half-transfer events."
      ],
      "crates": [
        "embedded-dma",
        "embassy-stm32",
        "embassy-rp"
      ],
      "github": [
        {
          "name": "embassy-rs/embassy - DMA Transfer types for stm32 and rp",
          "url": "https://github.com/embassy-rs/embassy"
        }
      ],
      "pitfall": "Passing a stack buffer to a DMA start call. The function returns, the stack frame is reused, and the DMA engine writes over whatever now lives there - usually the return address.",
      "resources": [
        {
          "title": "embedded-dma: ReadBuffer and WriteBuffer contracts",
          "url": "https://docs.rs/embedded-dma/latest/embedded_dma/",
          "kind": "docs"
        },
        {
          "title": "embassy-stm32 dma module: Transfer and ring buffers",
          "url": "https://docs.rs/embassy-stm32/latest/embassy_stm32/dma/index.html",
          "kind": "docs"
        },
        {
          "title": "embassy-rp dma: channel and Transfer API",
          "url": "https://docs.rs/embassy-rp/latest/embassy_rp/dma/index.html",
          "kind": "docs"
        },
        {
          "title": "embassy source: DMA Transfer ownership model",
          "url": "https://github.com/embassy-rs/embassy",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x13",
      "n": 13,
      "title": "defmt: logging that costs bytes, not milliseconds",
      "minutes": 75,
      "level": "advanced",
      "goal": "Use defmt so log formatting happens on the host, and budget the wire cost, flash cost and ISR impact of every log line.",
      "sections": [
        {
          "h": "Formatting moved off the device",
          "p": [
            "A printf-style log builds a string on the MCU: integer-to-ASCII, padding, a 64-byte buffer, then a blocking UART write. On a 48 MHz core with a 115200 baud link, a single line can cost a millisecond. defmt inverts this. The format string is interned in flash, the device sends only an index plus the raw arguments, and probe-rs looks up the string in the ELF and renders it on your laptop.",
            "The wire cost collapses to a few bytes per call, and the CPU cost is roughly storing arguments into a buffer. That is what makes logging affordable in an ISR or a 1 kHz control loop, where a printf would change the timing behaviour you are trying to observe."
          ],
          "code": "use defmt::{info, warn, Format};\n\n#[derive(Format)]\npub struct Sample {\n    channel: u8,\n    millivolts: u16,\n    valid: bool,\n}\n\nfn report(s: &Sample) {\n    info!(\"sample ch={} mv={} valid={}\", s.channel, s.millivolts, s.valid);\n    if !s.valid {\n        warn!(\"channel {} out of range: {} mV\", s.channel, s.millivolts);\n    }\n}",
          "tip": "defmt format strings are not std::fmt. Use {=u32} to pin a type, {=str} for strings, and derive Format rather than expecting {:?}."
        },
        {
          "h": "Transport, buffers and the price of a log",
          "p": [
            "defmt only defines the encoding; a logger crate provides the transport. defmt-rtt 1.3 writes into an RTT ring buffer that the debugger reads over SWD without halting the core. RTT buffers are sized by the linker and by constants in the logger: too small and messages are dropped when the host is not draining fast enough.",
            "Three costs to budget: flash (each distinct format string plus its arguments), RAM (the RTT buffer, typically 1 to 4 KB per channel), and time (a few microseconds per call, more if the buffer must be drained). A log line in a 20 kHz control loop is a design change, not an observation."
          ],
          "list": [
            "Distinct format strings are interned once in flash; reusing a string costs nothing extra",
            "Arguments are encoded, so a {=u32} costs about a byte on the wire",
            "Every buffer has a size, and overflow drops messages silently unless you watch the host counter",
            "Levels are filtered at compile time with the DEFMT_LOG environment variable"
          ]
        },
        {
          "h": "Panics, timestamps and assertions",
          "p": [
            "panic-probe turns a panic into a defmt record with file, line and message, then halts - which is why a crash on the bench shows you a source location instead of a silent reset loop. In production you pair panic-halt or a reset-and-record strategy with the same message captured to non-volatile memory if the failure must survive.",
            "Timestamps come from defmt::timestamp!, which you implement over your monotonic clock. Without it, the host stamps arrival time, which includes RTT buffering jitter, USB scheduling and the time the decoder needed to read the buffer. That is fine for a single line of text and useless for reconstructing whether the sensor read finished before or after the radio transmit. Set the hook once, in microseconds, from the same monotonic the scheduler uses, and every log line becomes a real event in device time."
          ],
          "code": "// main.rs: install the logger and timestamp source once\nuse defmt_rtt as _;\nuse panic_probe as _;\n\n// Timestamp hook: microseconds since boot from the monotonic.\n// defmt::timestamp!(\"{=u64:tus}\", embassy_time::Instant::now().as_micros());\n\n// Compile-time filtering:\n// $ DEFMT_LOG=info cargo run --release\n// $ DEFMT_LOG=warn cargo build --release"
        }
      ],
      "exercise": {
        "prompt": "Add structured logging to a sensor pipeline without logging inside the 10 kHz ISR: the ISR counts events, a task logs an aggregate once per second with the drop count and the worst-case latency.",
        "starter": "fn sample_isr() {\n    // runs at 10 kHz: no logging here\n}\n\nasync fn reporter() {\n    // TODO: once per second, log total, drops, max latency\n}",
        "hint": "Keep the ISR to atomics: total, drops, and a max of the measured latency. Read them in the task with swap and fetch_max, then log one line per second. That keeps wire traffic bounded and independent of ISR rate.",
        "solution": "use core::sync::atomic::{AtomicU32, Ordering};\nuse embassy_time::{Duration, Ticker};\n\nstatic TOTAL: AtomicU32 = AtomicU32::new(0);\nstatic DROPS: AtomicU32 = AtomicU32::new(0);\nstatic MAX_LAT_US: AtomicU32 = AtomicU32::new(0);\n\n#[inline(always)]\nfn sample_isr(latency_us: u32, ok: bool) {\n    TOTAL.fetch_add(1, Ordering::Relaxed);\n    if !ok {\n        DROPS.fetch_add(1, Ordering::Relaxed);\n    }\n    MAX_LAT_US.fetch_max(latency_us, Ordering::Relaxed);\n}\n\nasync fn reporter() {\n    let mut tick = Ticker::every(Duration::from_secs(1));\n    loop {\n        tick.next().await;\n        let total = TOTAL.swap(0, Ordering::Relaxed);\n        let drops = DROPS.swap(0, Ordering::Relaxed);\n        let worst = MAX_LAT_US.swap(0, Ordering::Relaxed);\n        defmt::info!(\n            \"1s: samples={} drops={} worst_latency_us={}\",\n            total, drops, worst\n        );\n    }\n}"
      },
      "questions": [
        {
          "q": "Where is the format string in a defmt log line?",
          "options": [
            "In the RTT buffer, compressed with RLE",
            "Interned in flash, referenced by index and rendered by the host",
            "On the stack, then sent as UTF-8",
            "In the debugger's symbol cache only"
          ],
          "answer": 1,
          "explain": "The device transmits an index plus encoded arguments. The host resolves the string from the ELF, which is why the ELF must match the flashed image."
        },
        {
          "q": "Why must a defmt-decode failure be suspected when logs look garbled?",
          "options": [
            "The RTT buffer is too large",
            "The ELF used for decoding does not match the firmware actually running",
            "defmt only supports one message per second",
            "The host clock drifted"
          ],
          "answer": 1,
          "explain": "Indices are resolved against the ELF. Flash a rebuild without re-running the decoder and the string table shifts, producing nonsense or decoder errors."
        }
      ],
      "quickbytes": [
        "Keep defmt-rtt in dev and early production builds; it costs a few KB of RAM but saves days.",
        "Never log per-sample at kHz rates: aggregate in atomics and emit one line per second.",
        "Set the RTT buffer from measured burst size, and watch for dropped-message counts on the host.",
        "Use DEFMT_LOG to compile out levels; a filtered-out log costs zero flash and zero cycles."
      ],
      "production": [
        "Log levels are compile-time filtered per build profile, not runtime-checked.",
        "ISRs contain no log calls; they record counters that a task reports.",
        "The RTT buffer size is documented with the burst it was sized for, and drops are monitored.",
        "Release builds keep panic messages while disabling verbose logging."
      ],
      "crates": [
        "defmt",
        "defmt-rtt",
        "panic-probe"
      ],
      "github": [
        {
          "name": "knurling-rs/defmt - the encoding and macros",
          "url": "https://github.com/knurling-rs/defmt"
        }
      ],
      "pitfall": "Logging inside a 10 kHz timer ISR. The RTT write occasionally blocks long enough to miss the next interrupt, and the timing bug only appears when logging is enabled.",
      "resources": [
        {
          "title": "defmt API and format syntax",
          "url": "https://docs.rs/defmt/latest/defmt/",
          "kind": "docs"
        },
        {
          "title": "defmt-rtt: the RTT transport logger",
          "url": "https://docs.rs/defmt-rtt/latest/defmt_rtt/",
          "kind": "docs"
        },
        {
          "title": "defmt repository: book, format reference, changelog",
          "url": "https://github.com/knurling-rs/defmt",
          "kind": "repo"
        },
        {
          "title": "defmt-test: on-target test harness",
          "url": "https://github.com/knurling-rs/defmt-test",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x14",
      "n": 14,
      "title": "probe-rs: flash, run, and read RTT",
      "minutes": 70,
      "level": "core",
      "goal": "Drive a whole debug cycle from the command line: identify the chip, flash, decode defmt, and run on-target tests in CI.",
      "sections": [
        {
          "h": "One tool instead of three",
          "p": [
            "probe-rs 0.32 replaces openocd, pyocd and a vendor flash utility with one binary that speaks CMSIS-DAP, ST-Link and J-Link over SWD or JTAG. It reads the chip definition from its target database, so there is no board config file to maintain - just a chip name. probe-rs list tells you which probes are attached, and probe-rs info identifies the connected target even when you have forgotten which board is on the desk.",
            "The important difference from a generic debugger is that probe-rs understands defmt and RTT natively. probe-rs run flashes the ELF, resets the target and attaches to RTT in one command, decoding log records as they arrive. That single loop - edit, run, read - is most of your debugging time, and removing the three-tool dance of openocd, telnet and a separate terminal changes how often you actually look at the device instead of guessing."
          ],
          "code": "# list attached probes\nprobe-rs list\n\n# identify the target behind the probe\nprobe-rs info --protocol swd\n\n# flash, reset, and decode defmt over RTT\nprobe-rs run --chip STM32F411CEUx target/thumbv7em-none-eabihf/debug/firmware\n\n# flash only, no RTT\nprobe-rs download --chip STM32F411CEUx --binary-format elf firmware.elf\n\n# attach to RTT on an already-running target\nprobe-rs attach --chip STM32F411CEUx firmware.elf",
          "tip": "If the chip name is wrong, probe-rs fails at the flash algorithm. Use probe-rs info and copy the exact part number from the datasheet."
        },
        {
          "h": "Wire it into cargo",
          "p": [
            "Put the runner in .cargo/config.toml so cargo run is the entire flash-and-log loop, and so CI uses the same command. Keep the chip name in one place; a second copy in a script will drift the first time someone swaps a board.",
            "The debug probe itself has limits worth knowing: SWD at high clock rates fails on long or poorly grounded cables, and some parts disable the debug port when a low-power mode is entered. If the probe stops seeing the chip after your firmware runs, suspect sleep, not the tool."
          ],
          "code": "# .cargo/config.toml\n[target.thumbv7em-none-eabihf]\nrunner = \"probe-rs run --chip STM32F411CEUx\"\nrustflags = [\n  \"-C\", \"link-arg=-Tlink.x\",\n  \"-C\", \"link-arg=-Tdefmt.x\",\n]\n\n# then, for the whole team:\n# $ cargo run --release\n# $ cargo test --target thumbv7em-none-eabihf"
        },
        {
          "h": "On-target tests in CI",
          "p": [
            "defmt-test provides a #[tests] harness: the test binary runs on the MCU, reports each case over defmt, and exits with a code probe-rs can surface. Combined with a bench rig of a few boards and a USB hub, this is how firmware gets real coverage of timer, DMA and peripheral code that no host test can reach.",
            "Keep the split honest. Pure logic - parsers, state machines, calibration math - belongs in host tests that run in milliseconds on every commit. Hardware-in-the-loop tests are slower and need the rig, so run them per merge and nightly, with the exact ELF that was built for release."
          ],
          "list": [
            "Host tests: pure functions, protocol parsing, debounce, buffers - no hardware",
            "On-target tests: register access, interrupt latency, DMA and timer behaviour",
            "HIL smoke test: flash the release image, boot, verify one telemetry frame",
            "Keep a known-good probe and board pinned in CI so failures are reproducible"
          ]
        }
      ],
      "exercise": {
        "prompt": "Write the .cargo/config.toml and the test wiring so that cargo test runs defmt-test cases on hardware, while cargo test --lib still runs host unit tests.",
        "starter": "# .cargo/config.toml goes here\n# [[test]] entry goes in Cargo.toml",
        "hint": "Add a [[test]] section with harness = false for tests/on_target.rs, keep the default lib test target, and set the runner for the embedded target only. Host tests run with the default target, so they are unaffected.",
        "solution": "# .cargo/config.toml\n[target.thumbv7em-none-eabihf]\nrunner = \"probe-rs run --chip STM32F411CEUx\"\nrustflags = [\"-C\", \"link-arg=-Tlink.x\", \"-C\", \"link-arg=-Tdefmt.x\"]\n\n# Cargo.toml\n# [[test]]\n# name = \"on_target\"\n# harness = false\n\n# tests/on_target.rs\n#![no_std]\n#![no_main]\n\nuse defmt_rtt as _;\nuse panic_probe as _;\n\n#[defmt_test::tests]\nmod tests {\n    use super::*;\n\n    #[init]\n    fn init() {}\n\n    #[test]\n    fn timer_ticks_once_per_millisecond() {\n        // hardware assertions go here\n        defmt::assert!(true);\n    }\n}\n\n# Commands:\n# $ cargo test --lib                      # host tests\n# $ cargo test --test on_target --target thumbv7em-none-eabihf"
      },
      "questions": [
        {
          "q": "Why does probe-rs need the ELF file for defmt output?",
          "options": [
            "To verify the flash checksum",
            "To resolve interned format strings and symbol addresses that the device only sends as indices",
            "To size the RTT buffer",
            "To select the correct flash algorithm"
          ],
          "answer": 1,
          "explain": "defmt transmits indices, not text. The decoder resolves them from the ELF, so the file must be the one that produced the running image."
        },
        {
          "q": "The probe stops detecting the target after your firmware starts. Most likely cause?",
          "options": [
            "The ELF is stale",
            "The firmware enters a low-power mode that disables the debug interface",
            "The RTT buffer is too small",
            "probe-rs needs the --release flag"
          ],
          "answer": 1,
          "explain": "Deep sleep modes can gate the debug logic. Either keep debug enabled in the low-power configuration or wake on probe connect during bring-up."
        }
      ],
      "quickbytes": [
        "probe-rs info identifies an unknown board; probe-rs list finds the probe.",
        "cargo run through a runner entry keeps the flash loop identical for every developer and for CI.",
        "On-target tests with defmt-test cover what host tests cannot: registers, timing, DMA.",
        "Run HIL tests against the release ELF, not a debug build, or you test different code."
      ],
      "production": [
        "The runner command exists in the repository, not in a wiki page.",
        "CI separates fast host tests from hardware-in-the-loop tests with different triggers.",
        "A known-good probe and board pair is reserved for CI so failures are attributable.",
        "Release artifacts are archived with their ELFs, so field logs can be decoded later."
      ],
      "crates": [
        "probe-rs",
        "defmt-test",
        "panic-probe"
      ],
      "github": [
        {
          "name": "probe-rs/probe-rs - debugger, flasher, RTT",
          "url": "https://github.com/probe-rs/probe-rs"
        },
        {
          "name": "knurling-rs/defmt-test - on-target test harness",
          "url": "https://github.com/knurling-rs/defmt-test"
        }
      ],
      "pitfall": "Debugging with a stale ELF open in the decoder. Logs read as garbage or silently misattribute values, and you spend an afternoon chasing a bug that only exists in the mismatch.",
      "resources": [
        {
          "title": "probe-rs crate and CLI documentation",
          "url": "https://docs.rs/probe-rs/latest/probe_rs/",
          "kind": "docs"
        },
        {
          "title": "probe-rs repository: target database and CLI docs",
          "url": "https://github.com/probe-rs/probe-rs",
          "kind": "repo"
        },
        {
          "title": "defmt-test: writing on-target tests",
          "url": "https://github.com/knurling-rs/defmt-test",
          "kind": "repo"
        },
        {
          "title": "The Embedded Rustacean: flashing and debugging embedded Rust",
          "url": "https://www.youtube.com/@theembeddedrustacean",
          "kind": "video"
        }
      ]
    },
    {
      "id": "x15",
      "n": 15,
      "title": "Memory: stack, statics and the linker map",
      "minutes": 90,
      "level": "industry",
      "goal": "Account for every kilobyte: size the stack from measurement, keep statics honest, and make overflow a fault instead of corruption.",
      "sections": [
        {
          "h": "Where the RAM goes",
          "p": [
            "On a 128 KiB part, RAM is statics plus stack plus heap; on most firmware the heap is zero and the stack is one region. Statics come from .data (initialised, copied at boot), .bss (zeroed) and .uninit (untouched). The map file is the ground truth: cargo size gives you text/data/bss, and reading the .map tells you which module is responsible for the 4 KiB you did not expect.",
            "A single large array in a driver is the usual surprise. A 4 KiB ADC buffer declared as a local in a task becomes a stack allocation, and three tasks with 4 KiB buffers each is a RAM budget you never approved."
          ],
          "code": "# .text, .data and .bss for the whole image\ncargo size --release --bin firmware   # cargo-binutils\n\n# per-symbol breakdown: who owns the 4 KiB?\ncargo nm --release --bin firmware -- -S --size-sort | tail -20\n\n# with flip-link installed, the stack lives below .bss\n# so an overflow leaves RAM and faults immediately\ncargo install flip-link"
        },
        {
          "h": "Measure the stack, do not guess",
          "p": [
            "Paint the stack with a known pattern before main runs, run the worst-case workload for long enough to hit every path, then scan from the stack base upward to find the deepest word that changed. That is a high-water mark, and it is the only number worth designing against. Add margin for the paths you did not exercise - an error handler that formats a message is often the deepest call chain in the image.",
            "flip-link reorders memory so the stack grows towards unmapped space rather than into .bss. Then an overflow triggers a fault you can log instead of silently corrupting a counter that fails a week later. It is a one-line change with a large diagnostic payoff."
          ],
          "list": [
            "Paint-and-scan gives a measured high-water mark, per build and per workload",
            "Add 30-50 percent margin over the measured peak, more if recursion or formatting is reachable",
            "flip-link turns overflow into a HardFault instead of data corruption",
            "An MPU region below the stack gives a precise fault address if you need one"
          ],
          "code": "// Paint the unused stack once, then scan for the high-water mark.\n// `_stack_start` comes from memory.x / link.x.\nextern \"C\" {\n    static mut _stack_start: u32;\n}\n\n#[inline(never)]\nfn deepest_path(n: u32, acc: &mut u32) {\n    let buf = [0u8; 512];\n    *acc = acc.wrapping_add(buf[0] as u32 + n);\n}",
          "tip": "Measure stack with the panic path and the error path enabled. Those are usually the deepest frames and they are absent from happy-path testing."
        },
        {
          "h": "Fixed capacity, fragmentation, and .uninit",
          "p": [
            "If you link an allocator, your worst-case RAM is no longer a number in the map file - it is a property of the workload, including fragmentation. That is a defensible trade for a device that reboots often and a bad one for a sensor node that must run for years. heapless containers make capacity part of the type, so the compiler enforces the budget.",
            "For state that must survive a soft reset - reset cause, boot counters, crash records - use a #[link_section = \".uninit\"] static. It is not zeroed by the startup code, so you must initialise it on cold boot by checking a magic value. That is exactly how you get a post-mortem out of a device that resets in the field."
          ],
          "code": "#[link_section = \".uninit\"]\n#[used]\nstatic mut BOOT_RECORD: BootRecord = BootRecord {\n    magic: 0,\n    resets: 0,\n    last_fault: 0,\n};\n\n#[repr(C)]\nstruct BootRecord {\n    magic: u32,\n    resets: u32,\n    last_fault: u32,\n}\n\nconst MAGIC: u32 = 0x424F_4F54; // \"BOOT\"\n\n/// Call first in main, before anything else touches BOOT_RECORD.\nunsafe fn boot_record() -> &'static mut BootRecord {\n    let rec = &mut *core::ptr::addr_of_mut!(BOOT_RECORD);\n    if rec.magic != MAGIC {\n        rec.magic = MAGIC;\n        rec.resets = 0;\n        rec.last_fault = 0;\n    }\n    rec.resets += 1;\n    rec\n}"
        }
      ],
      "exercise": {
        "prompt": "Given text=18 KiB, data=152 B, bss=6 KiB on a 128 KiB part and a measured stack high-water mark of 3.1 KiB, compute the RAM headroom and state whether a 4 KiB DMA buffer fits with a 40 percent stack margin.",
        "starter": "// text: 18 KiB (flash)  data: 152 B  bss: 6 KiB  stack peak: 3.1 KiB\n// RAM = 128 KiB. Compute: used, headroom, verdict on +4 KiB.",
        "hint": "RAM use is data + bss + stack (text is flash). With 40 percent margin, stack budget is 3.1 * 1.4 = 4.34 KiB. Add 4 KiB of buffer to statics and re-check.",
        "solution": "// RAM budget, 128 KiB total\n//\n// statics = data 152 B + bss 6 KiB              = 6,296 B\n// stack   = 3.1 KiB measured * 1.40 margin       = 4,444 B\n// used                                           = 10,740 B\n// headroom                                       = 131,072 - 10,740 = 120,332 B (~117 KiB)\n//\n// Adding a 4 KiB DMA buffer to .bss:\n// statics = 6,296 + 4,096 = 10,392 B\n// used    = 10,392 + 4,444 = 14,836 B\n// headroom= 116,236 B (~113 KiB) -> fits comfortably.\n//\n// The verdict is about more than arithmetic: the buffer must be a static\n// (DMA needs a stable address), aligned to 32 bytes, and it must not sit\n// adjacent to state whose cache line could be invalidated.\n\n#[repr(align(32))]\nstruct DmaBuf([u8; 4096]);\n\n#[link_section = \".bss.dma\"]\nstatic mut ADC_DMA: DmaBuf = DmaBuf([0; 4096]);"
      },
      "questions": [
        {
          "q": "Why does flip-link change the failure mode of a stack overflow?",
          "options": [
            "It allocates a heap so overflow cannot happen",
            "It places the stack so growth leaves RAM, producing a fault instead of corrupting .bss",
            "It compresses the stack frames",
            "It doubles the stack size automatically"
          ],
          "answer": 1,
          "explain": "Default layouts put .bss below the stack, so overflow silently overwrites globals. flip-link moves the stack to the boundary so overflow faults immediately."
        },
        {
          "q": "A 4 KiB buffer declared inside an async task function ends up where?",
          "options": [
            "In flash, because it is const",
            "In the task's static future, consuming RAM for the lifetime of the firmware",
            "On the heap",
            "In a CPU register file"
          ],
          "answer": 1,
          "explain": "Embassy tasks are static futures, so locals live in that static for the whole program. Large buffers must be deliberate statics, not task locals."
        }
      ],
      "quickbytes": [
        "cargo size for the total, cargo nm -S --size-sort for the culprit.",
        "Design the stack from a painted high-water mark plus 30-50 percent, not from a round number.",
        "Link flip-link in development and CI; overflow should fault, not corrupt.",
        ".uninit plus a magic word is how reset cause and crash records survive a reboot."
      ],
      "production": [
        "The linker map is archived per release and diffed for unexpected growth.",
        "Stack high-water marks are measured for the worst-case workload including error paths.",
        "DMA and large buffers are named, aligned statics reviewed in the memory budget.",
        "Any allocator use has a documented peak-usage test and a fragmentation argument."
      ],
      "crates": [
        "cortex-m",
        "heapless",
        "flip-link"
      ],
      "github": [
        {
          "name": "knurling-rs/flip-link - stack overflow detection",
          "url": "https://github.com/knurling-rs/flip-link"
        }
      ],
      "pitfall": "Declaring a large buffer inside an async task for convenience. It becomes part of the static future, and the RAM cost is paid for the entire uptime of the device.",
      "resources": [
        {
          "title": "The Embedded Rust Book: memory layout and stack sizing",
          "url": "https://github.com/rust-embedded/book",
          "kind": "repo"
        },
        {
          "title": "flip-link: stack placement and overflow faults",
          "url": "https://github.com/knurling-rs/flip-link",
          "kind": "repo"
        },
        {
          "title": "heapless: fixed-capacity containers",
          "url": "https://docs.rs/heapless/latest/heapless/",
          "kind": "docs"
        }
      ]
    },
    {
      "id": "x16",
      "n": 16,
      "title": "Power: sleep modes, tickless idle and the budget",
      "minutes": 95,
      "level": "industry",
      "goal": "Compute an energy budget from measured currents, cut the two or three terms that dominate it, and verify with a real measurement.",
      "sections": [
        {
          "h": "Average current is the only number that matters",
          "p": [
            "Battery life is charge divided by average current, and average current is a weighted sum: (I_active x t_active + I_sleep x t_sleep) / period. A node that wakes for 100 ms at 20 mA and sleeps for 10 s at 5 uA averages about 205 uA, so the sleep term is nearly irrelevant and the active duty cycle is everything. Optimise the dominant term first, and measure before optimising either.",
            "That calculation also tells you when the datasheet is lying to you. A 2 uA stop-mode figure assumes every peripheral is off, every pin is at a defined level, and the debugger is disconnected. Your board has a regulator with quiescent current, a pull-up on an I2C line, and an LED that never turns fully off."
          ],
          "code": "// Budget example, 10 s period\n// active:  20 mA for 100 ms  -> 2.0 mA*s / 10 s = 200 uA average\n// sleep:   5 uA for 9.9 s    -> 0.0495 mA*s / 10 s = 4.95 uA average\n// total:   ~205 uA  -> 1000 mAh / 0.205 mA = ~4870 h = ~203 days\n//\n// halving the active window to 50 ms saves ~100 uA\n// halving sleep current to 2.5 uA saves ~2.5 uA",
          "tip": "Compute the budget before choosing a sleep mode. Most projects spend weeks shaving microamps off the sleep term while the active duty cycle dominates."
        },
        {
          "h": "What actually keeps the chip awake",
          "p": [
            "WFI sleeps until an enabled interrupt fires; WFE sleeps until an event, which lets you keep interrupts masked while waiting. Both are one instruction, but the mode you enter is set by the SCB and the PWR block: a plain sleep keeps the core clock running, deep sleep gates it, stop mode powers down most of the chip while retaining RAM, and standby goes further and loses it.",
            "The usual leaks are boring. A pin left floating draws cross-conduction current. A pull-up on a line that is driven low burns V/R continuously. A UART left enabled with its clock on draws hundreds of microamps. A debugger attached prevents the deepest modes entirely, so the board looks fine on the bench and dies in the field."
          ],
          "list": [
            "Disable peripherals you are not using; clock gating beats sleeping with a peripheral on",
            "Configure unused pins as analog, never floating",
            "Remove or switch off pull resistors on lines that are actively driven",
            "Disconnect the debugger for any sleep-current measurement"
          ],
          "code": "// Cortex-M: enter deep sleep until the next interrupt.\n// The exact mode is chosen in the SCB / PWR registers by the HAL.\nfn idle_wait() {\n    cortex_m::asm::dsb();\n    cortex_m::asm::wfi(); // wake on the next enabled interrupt\n}\n\n// the embassy thread-mode executor does this automatically when\n// no task is ready, waking at the next scheduled deadline."
        },
        {
          "h": "Tickless idle and the price of a 1 kHz tick",
          "p": [
            "A 1 kHz SysTick wakes the core a thousand times a second even when nothing needs to happen. At roughly 3 mA for a wake-and-return, that is a floor of a few milliamps of average current - fatal for a coin cell. Tickless designs reprogram a low-power timer to the next deadline instead, so an idle second costs one wake, not a thousand.",
            "embassy-time is tickless by construction: the executor asks the time driver for the next expiration and sleeps until then. RTIC with the systick monotonic is explicitly not: the crate documentation warns that it ticks at a constant rate. If sleep current is a requirement, use a hardware-timer monotonic and let the tick interrupt be the only wake source."
          ]
        }
      ],
      "exercise": {
        "prompt": "A node samples for 40 ms at 12 mA every 60 s, and sleeps at 4 uA otherwise. Compute the average current and the life of a 2200 mAh cell; then compute the life if sampling drops to 10 ms.",
        "starter": "// 40 ms @ 12 mA every 60 s, sleep 4 uA, 2200 mAh\n// TODO: average current, lifetime in days, and the 10 ms variant",
        "hint": "Convert to mA and seconds: active charge = 12 mA * 0.040 s = 0.48 mA*s per 60 s period, so 0.008 mA average. Sleep charge = 0.004 mA * 59.96 s / 60 s. Sum, then 2200 / average.",
        "solution": "// 40 ms variant\n// active: 12 mA * 0.040 s = 0.48 mA*s per period\n// sleep:  0.004 mA * 59.96 s = 0.2398 mA*s per period\n// total per period = 0.7198 mA*s over 60 s -> 0.012 mA average\n// life = 2200 mAh / 0.012 mA = 183,333 h = ~7639 days (20+ years)\n// -> the cell self-discharge and the regulator now dominate; the MCU is irrelevant.\n//\n// 10 ms variant\n// active: 12 * 0.010 = 0.12 mA*s\n// total  = 0.3598 mA*s / 60 s = 0.006 mA average\n// life   = 366,667 h (~41 years)\n//\n// Conclusion: at this duty cycle the budget is set by sleep leakage and\n// by the regulator, not by the on-time. Measure the board, not the MCU.\n\nconst ACTIVE_MA: f32 = 12.0;\nconst SLEEP_MA: f32 = 0.004;\nconst CAPACITY_MAH: f32 = 2200.0;\n\nfn average_ma(active_s: f32, period_s: f32) -> f32 {\n    (ACTIVE_MA * active_s + SLEEP_MA * (period_s - active_s)) / period_s\n}\n\nfn lifetime_days(avg_ma: f32) -> f32 {\n    CAPACITY_MAH / avg_ma / 24.0\n}\n\nfn main() {\n    let avg = average_ma(0.040, 60.0);\n    println!(\"{:.4} mA, {:.0} days\", avg, lifetime_days(avg));\n    let avg_fast = average_ma(0.010, 60.0);\n    println!(\"{:.4} mA, {:.0} days\", avg_fast, lifetime_days(avg_fast));\n}"
      },
      "questions": [
        {
          "q": "A design wakes every 60 s for 40 ms at 12 mA and sleeps at 4 uA. Which term dominates the average?",
          "options": [
            "The sleep current",
            "The active window, because 12 mA for 40 ms outweighs 4 uA for 60 s",
            "Neither; the regulator always dominates",
            "They are equal by construction"
          ],
          "answer": 1,
          "explain": "Active charge is 0.48 mA*s per period versus 0.24 mA*s asleep, even with a duty cycle below 0.1 percent. Milliamps beat microamps regardless of time."
        },
        {
          "q": "Why can a 1 kHz SysTick prevent a low-power design from reaching its sleep target?",
          "options": [
            "It disables the RTC",
            "It wakes the core a thousand times per second even when idle, each wake costing milliseconds of active current",
            "It increases the flash wait states",
            "It forces the debugger to stay attached"
          ],
          "answer": 1,
          "explain": "Every wake costs entry, execution and exit. A tickless timer programmed to the next deadline replaces a thousand wakes with one."
        },
        {
          "q": "Sleep current measures 400 uA instead of the expected 5 uA. What should you check first?",
          "options": [
            "The compiler optimisation level",
            "Unused floating pins, pull resistors on driven lines, and peripherals left clocked",
            "The flash wait-state configuration",
            "The linker script"
          ],
          "answer": 1,
          "explain": "Hundreds of microamps of excess is almost always I/O configuration or a peripheral that was never disabled - not the core sleep mode itself."
        }
      ],
      "quickbytes": [
        "Optimise the dominant term: compute the weighted average before touching sleep modes.",
        "Disconnect the debugger for any sleep measurement; it keeps debug logic alive.",
        "Tickless timers replace a 1 kHz wake with one wake at the next deadline.",
        "Measure at the battery with a PPK2 or Joulescope; a multimeter averages away the spikes that matter."
      ],
      "production": [
        "The energy budget is a spreadsheet with measured currents per state and a stated battery life.",
        "Sleep current is validated on the final board with the debugger disconnected.",
        "Every peripheral not needed in sleep is explicitly disabled and its clock gated.",
        "The wake source list, including RTC and EXTI, is documented and reviewed for leakage."
      ],
      "crates": [
        "embassy-time",
        "cortex-m",
        "embassy-stm32"
      ],
      "github": [
        {
          "name": "embassy-rs/embassy - tickless time driver and executor idle",
          "url": "https://github.com/embassy-rs/embassy/tree/main/embassy-time"
        }
      ],
      "pitfall": "Measuring sleep current with the debugger attached. The debug logic keeps a clock domain alive and the board reads hundreds of microamps high, so the team optimises a problem that does not exist.",
      "resources": [
        {
          "title": "embassy-time: tickless timebase and deadline scheduling",
          "url": "https://docs.rs/embassy-time/latest/embassy_time/",
          "kind": "docs"
        },
        {
          "title": "Embassy book: low-power and executor idle behaviour",
          "url": "https://embassy.dev/book/",
          "kind": "docs"
        },
        {
          "title": "rtic-monotonics: why a constant-rate tick costs power",
          "url": "https://docs.rs/rtic-monotonics/latest/rtic_monotonics/",
          "kind": "docs"
        },
        {
          "title": "embassy-time source: deadline-driven sleep behaviour",
          "url": "https://github.com/embassy-rs/embassy/tree/main/embassy-time",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x17",
      "n": 17,
      "title": "Choosing a HAL: STM32, nRF, RP and ESP compared",
      "minutes": 85,
      "level": "advanced",
      "goal": "Pick a vendor family and HAL layer on evidence - async support, PAC quality, blobs, maintenance - instead of on a demo that ran once.",
      "sections": [
        {
          "h": "Four families, four different bets",
          "p": [
            "STM32 has the widest part range and the most mature Rust support. stm32-rs maintains SVD-derived PACs for nearly the whole catalogue, and embassy-stm32 0.6 generates its HAL from stm32-metapac, so one API covers many families with async DMA and timers. The cost is a very large feature matrix and pin conflicts that the compiler catches only after you have chosen a package.",
            "nRF52 trades breadth for a coherent low-power design: easyDMA on every peripheral and a radio that is genuinely good. The catch is Bluetooth. The SoftDevice is a closed binary with its own scheduler, and mixing it with a no_std executor is a project in itself; nrf-softdevice exists precisely to manage that, and it is not a drop-in."
          ],
          "list": [
            "STM32: widest selection, generated PACs, strong embassy async coverage",
            "nRF52: best-in-class radio and low power, but SoftDevice constrains the architecture",
            "RP2040/RP2350: cheap, dual-core, PIO for custom protocols, no radio",
            "ESP32: integrated WiFi/BLE, but the radio stacks are vendor blobs"
          ]
        },
        {
          "h": "RP2040 and ESP32: different kinds of clever",
          "p": [
            "RP2040 and RP2350 (rp2040-hal 0.12, rp235x-hal 0.4, embassy-rp 0.10) are pleasant to program: the PIO state machines implement protocols that have no peripheral, and embassy-rp gives async everywhere. Two constraints matter. There is no radio, and code executing from external flash cannot erase or program that same flash - the flash routine must run from RAM, which the HALs handle but you should know exists.",
            "ESP32 (esp-hal 1.2) integrates WiFi and BLE, which is the reason to choose it. Those stacks are Espressif blobs with their own tasks and memory demands, so the binary is large and the idle current is not in the same class as an nRF. Xtensa parts also need the esp-rs toolchain fork; RISC-V parts build with stable Rust. Choose ESP when connectivity is the product, not when it is a checkbox."
          ]
        },
        {
          "h": "The evaluation checklist",
          "p": [
            "Score candidates on five things, in writing, before committing. Does the HAL expose the peripherals you need with the async or DMA path you need, or only blocking? Is the PAC generated from an SVD with a recent revision? Do the examples actually build for your exact chip? Does the design require a vendor blob, and can you live with its licence and binary size? And who maintains it - a company, a funded team, or one person answering issues at midnight?",
            "Portability is the tie-breaker only if you will actually port. A driver written against embedded-hal traits moves between families; application code that touches clocks, DMA channels and pin mappings does not. Budget the port as a rewrite of the board layer, not as a recompile."
          ],
          "code": "# Pin the family in the manifest, not in a build script\n[dependencies]\nembassy-executor = { version = \"0.10\", features = [\"platform-cortex-m\", \"executor-thread\"] }\nembassy-time = \"0.5\"\nembassy-stm32 = { version = \"0.6\", features = [\"stm32f411ce\", \"time-driver-any\", \"exti\"] }\n\n# nRF alternative: chip feature plus a time driver\n# embassy-nrf = { version = \"0.11\", features = [\"nrf52840\", \"time-driver-rtc1\"] }\n\n# RP2040 alternative\n# embassy-rp = { version = \"0.10\", features = [\"time-driver\"] }\n\n# The exact feature names for timers and EXTI follow the chip family;\n# copy them from the Cargo.toml of that HAL example rather than guessing.",
          "tip": "Prototype the two peripherals you are least sure about on real hardware before committing. Datasheet support is not HAL support."
        }
      ],
      "exercise": {
        "prompt": "Score STM32 + embassy-stm32 against nRF52 + embassy-nrf for a battery sensor node that needs BLE once per hour, I2C sensors, and 2 uA sleep. State which wins and what evidence would change your mind.",
        "starter": "// criteria: async coverage, radio, sleep current, blob/licence, maintenance\n// write the comparison and a decision",
        "hint": "Both have async HALs. The differentiator is BLE: the nRF SoftDevice or the newer radio support constrains scheduling and RAM, while STM32 needs an external BLE module. Sleep current and ecosystem maturity decide the rest.",
        "solution": "// Comparison for: hourly BLE advert, I2C sensors, 2 uA sleep target\n//\n// async coverage   STM32: embassy-stm32 covers I2C/SPI/UART with DMA.\n//                  nRF:   embassy-nrf covers the same with easyDMA.\n//                  -> tie.\n// radio            STM32: no radio; needs an external BLE SoC over UART/SPI,\n//                         which adds BOM, board area and a second firmware.\n//                  nRF:   radio in-package; SoftDevice or the embassy radio stack,\n//                         but either constrains RAM and scheduling.\n//                  -> nRF wins on integration, loses on architectural freedom.\n// sleep current    nRF52 is designed for it; 2 uA is achievable with the\n//                  radio off and the regulator chosen for quiescent current.\n//                  STM32 can reach single-digit uA in stop mode, but the\n//                  external BLE module will dominate unless it is powered down.\n//                  -> nRF wins.\n// blobs/licence    STM32: none for the MCU. nRF: SoftDevice is a closed binary.\n//                  If the SoftDevice is unacceptable, use the radio directly\n//                  and own the BLE stack - a large schedule risk.\n// maintenance      Both are actively maintained; embassy-nrf and embassy-stm32\n//                  share the embassy release cadence.\n//\n// Decision: nRF52 + embassy-nrf if the SoftDevice licence and RAM fit.\n// Change my mind if: the product needs WiFi, the BOM cannot absorb the nRF\n// price, or certification requires a stack the SoftDevice cannot provide."
      },
      "questions": [
        {
          "q": "What is the main architectural cost of choosing ESP32 for its integrated WiFi?",
          "options": [
            "No support for I2C",
            "The radio stack is a vendor blob with its own tasks, memory and idle-current profile",
            "It cannot run no_std at all",
            "It has no DMA"
          ],
          "answer": 1,
          "explain": "esp-hal is no_std, but WiFi/BLE come from Espressif binaries. They dominate flash, RAM and sleep current, and constrain your scheduler."
        },
        {
          "q": "Why can a program running from external flash not erase that flash directly on RP2040?",
          "options": [
            "Flash is read-only on RP2040",
            "The erase routine itself executes from the same flash, so it must be copied to RAM first",
            "The XIP cache is too small",
            "DMA channels are unavailable during flash access"
          ],
          "answer": 1,
          "explain": "Executing from XIP while erasing stalls the bus and kills the running code. The HALs place the flash routines in RAM for exactly this reason."
        },
        {
          "q": "When does embedded-hal portability actually pay off?",
          "options": [
            "For application code touching clocks, pins and DMA",
            "When you will genuinely port, and for driver crates that can then be reused across families",
            "Only for tests",
            "It always pays off equally"
          ],
          "answer": 1,
          "explain": "Drivers behind HAL traits move; board bring-up code is family-specific. Portability is a bet on reuse, and it should be justified like any other."
        }
      ],
      "quickbytes": [
        "Prototype the riskiest two peripherals on real hardware before committing to a family.",
        "embassy-stm32 is generated from metapac: one API across many STM32 families, at the cost of a large feature matrix.",
        "nRF wins on radio and sleep; accept the SoftDevice constraints or budget for owning the stack.",
        "RP2350 adds PIO and dual-core flexibility but still has no radio."
      ],
      "production": [
        "The chosen family and HAL version are recorded with the evaluation that selected them.",
        "Vendor blob dependencies are listed with licence, binary size and idle-current impact.",
        "The board layer is isolated in one crate so a family change is a contained rewrite.",
        "Pin mapping and feature flags are reviewed against the exact ordering code."
      ],
      "crates": [
        "embassy-stm32",
        "embassy-nrf",
        "embassy-rp",
        "esp-hal"
      ],
      "github": [
        {
          "name": "embassy-rs/embassy - stm32, nrf and rp HALs",
          "url": "https://github.com/embassy-rs/embassy"
        },
        {
          "name": "esp-rs/esp-hal - ESP32 no_std HAL",
          "url": "https://github.com/esp-rs/esp-hal"
        }
      ],
      "pitfall": "Choosing a family from a conference demo that used a different chip revision, then finding the async DMA path you need exists only for the family you did not pick.",
      "resources": [
        {
          "title": "embassy-stm32: generated HAL for STM32 families",
          "url": "https://docs.rs/embassy-stm32/latest/embassy_stm32/",
          "kind": "docs"
        },
        {
          "title": "embassy-nrf: async HAL with easyDMA",
          "url": "https://docs.rs/embassy-nrf/latest/embassy_nrf/",
          "kind": "docs"
        },
        {
          "title": "esp-hal source: ESP32 no_std HAL and radio integration",
          "url": "https://github.com/esp-rs/esp-hal",
          "kind": "repo"
        },
        {
          "title": "The Embedded Rustacean: board and HAL selection walkthroughs",
          "url": "https://www.youtube.com/@theembeddedrustacean",
          "kind": "video"
        },
        {
          "title": "Rust for Embedded Systems: current state, challenges and open problems",
          "url": "https://arxiv.org/abs/2311.05063",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "x18",
      "n": 18,
      "title": "RTIC vs Embassy vs FreeRTOS, Tock and Hubris",
      "minutes": 90,
      "level": "industry",
      "goal": "Choose a concurrency model on scheduling guarantees, isolation and certification needs, not on which example you got compiling first.",
      "sections": [
        {
          "h": "Three scheduling models, not three libraries",
          "p": [
            "RTIC 2 is a priority-based preemptive system with a compile-time resource map and the Stack Resource Policy. It has no heap, one stack, and worst-case blocking that follows from declared priorities - which is why it is the easiest of the Rust options to argue about in a design review. Embassy is cooperative in thread mode: tasks run to their next await point, and preemption only exists if you create separate executors at higher interrupt priorities.",
            "FreeRTOS is the classical answer: preemptive threads, per-task stacks, a heap, and a decade of middleware. In Rust you use it through bindings, so the boundary is unsafe FFI and the scheduler's guarantees are the C kernel's, not the Rust type system's. Zephyr is a full RTOS with devicetree and Kconfig; its Rust support is not first-class for application code, and you will spend more time in C configuration than in Rust."
          ],
          "list": [
            "RTIC: static priorities, compile-time resource ceilings, no heap, single stack",
            "Embassy: async tasks, tickless idle, preemption only via interrupt-mode executors",
            "FreeRTOS: preemptive threads, per-task stacks, heap, large middleware ecosystem",
            "Zephyr: full RTOS with device tree; Rust is a guest, not the host language"
          ]
        },
        {
          "h": "Isolation is a different axis",
          "p": [
            "Tock runs the kernel in Rust and applications as MPU-isolated processes, so a buggy app cannot corrupt the kernel or another app. That costs a process model, fixed process slots and MPU regions per process - and buys the ability to load third-party code. Hubris goes the other way: a small kernel with statically defined tasks, no dynamic memory, and a supervisor that restarts a faulted task. It is what Oxide ships on server management controllers.",
            "Neither is a drop-in for a single-purpose sensor node. They matter when the threat model includes code you did not write, or when a task must be restarted without rebooting the device. Both add a kernel crossing on the hot path, so an interrupt that took a microsecond in a flat firmware may take several through the scheduler. Measure before assuming the isolation is free."
          ]
        },
        {
          "h": "The decision, written down",
          "p": [
            "Ask four questions in order. Does anything need hard preemption with a provable bound? Then RTIC, or a second Embassy executor, or FreeRTOS. Is the code base mostly third-party or safety-certified middleware? Then FreeRTOS, because you are buying the ecosystem. Do you need to isolate untrusted or independently updatable code? Then Tock or Hubris. Does the product need certification? Then the framework must be justified or qualified, and a qualified compiler such as Ferrocene covers the language, not your HAL.",
            "Write the answer with the alternative you rejected and why. Two years later, when someone asks \"why not just use Embassy?\", that paragraph is the difference between an architectural decision and an accident. Include the residual risks you accepted - unanalysed vendor code, a cooperative task with a 2 ms run-to-await - because those are the assumptions that will be tested by the first field failure."
          ],
          "code": "// RTIC: the blocking bound follows from declared priorities.\n// Embassy: latency depends on the longest run-to-await in any task.\n// FreeRTOS: bound depends on priority assignment and stack sizing.\n//\n// Write the choice down next to the schedule:\n//\n// decision: embassy, single thread-mode executor + 1 interrupt executor\n// rejected: RTIC - the async sensor driver crate only ships async traits\n// risk:     no compile-time ceiling analysis; mitigated by keeping the\n//           control loop in the interrupt executor at priority 1\n// review:   re-evaluate if a task exceeds 200 us between await points",
          "tip": "The strongest argument for RTIC is a schedulability argument you can hand to a reviewer; the strongest for Embassy is code you can read. Pick the one your team can defend."
        }
      ],
      "exercise": {
        "prompt": "A medical pump needs a 1 ms control loop, a BLE stack from a vendor, and a documented worst-case latency. Which model do you choose, and what do you write in the decision record?",
        "starter": "// constraints: 1 ms hard loop, vendor BLE, documented WCET\n// choose: RTIC | Embassy | FreeRTOS | Tock | Hubris\n// justify with the four questions",
        "hint": "A hard 1 ms bound with a vendor stack points to a preemptive system where the control loop has the highest priority. RTIC gives the bound in Rust; FreeRTOS gives it with the vendor integration already done. Name the rejected option and the residual risk.",
        "solution": "// Constraints\n// - 1 ms control loop, jitter budget 50 us\n// - vendor BLE stack supplied as a binary with its own scheduler\n// - worst-case latency must be documented for review\n//\n// Decision: FreeRTOS with the control loop at the highest application\n// priority, Rust for the application tasks via bindings, C for the vendor\n// stack. Reason: the vendor stack already integrates with FreeRTOS; making\n// it coexist with an executor would move risk into an area we cannot\n// inspect, and would invalidate the vendor support agreement.\n//\n// Rejected: RTIC. Better latency story in pure Rust, but the BLE stack\n// cannot be scheduled by it, so the loop bound would be at the mercy of an\n// unanalysable binary. Rejected: Embassy. Cooperative thread mode cannot\n// meet a 50 us jitter budget without pushing the loop into an interrupt\n// executor, at which point the async benefit is gone.\n//\n// Residual risks, documented:\n// 1. FreeRTOS heap fragmentation from the vendor stack - fixed by static\n//    allocation for all application tasks and a vendor-provided pool.\n// 2. unsafe FFI boundary - every wrapper reviewed and covered by an\n//    integration test that exercises queue and semaphore paths.\n// 3. Stack sizing - high-water marks measured for each task under load."
      },
      "questions": [
        {
          "q": "What does RTIC give you that a cooperative executor does not?",
          "options": [
            "Smaller binary size",
            "Preemptive priorities with a compile-time resource ceiling, hence a computable blocking bound",
            "Support for async drivers",
            "A heap for dynamic tasks"
          ],
          "answer": 1,
          "explain": "Preemption plus the ceiling protocol yields worst-case blocking derived from declared priorities - the property a schedulability argument needs."
        },
        {
          "q": "When is Tock the right choice?",
          "options": [
            "A single-purpose sensor node with no third-party code",
            "When untrusted or independently developed applications must be isolated from the kernel and each other",
            "When you need the smallest possible binary",
            "When you need WiFi"
          ],
          "answer": 1,
          "explain": "Tock's MPU-isolated process model buys safety for code you did not write, at the cost of a process abstraction and fixed slots."
        },
        {
          "q": "Ferrocene qualifies the Rust toolchain. What does that leave unqualified?",
          "options": [
            "Nothing, the whole system is qualified",
            "Your HAL, drivers, RTOS and application logic",
            "Only the linker",
            "The target hardware"
          ],
          "answer": 1,
          "explain": "A qualified compiler and core library are necessary but not sufficient. Every other component needs its own qualification evidence or a justified argument."
        }
      ],
      "quickbytes": [
        "RTIC for provable preemption, Embassy for readable concurrency, FreeRTOS for ecosystem, Tock/Hubris for isolation.",
        "Cooperative scheduling means your worst-case latency is the longest run-to-await in any task.",
        "Per-task stacks plus a heap means stack sizing and fragmentation become your reliability problem.",
        "Record the rejected alternative; it is the only defence against re-litigating the choice every year."
      ],
      "production": [
        "The concurrency model is recorded with its scheduling argument and rejected alternatives.",
        "Worst-case latency is measured under load, not assumed from the framework documentation.",
        "FFI boundaries to a C RTOS are wrapped, reviewed and covered by integration tests.",
        "Any certified component is listed with the exact qualification scope and version."
      ],
      "crates": [
        "rtic",
        "embassy-executor",
        "embassy-sync"
      ],
      "github": [
        {
          "name": "tock/tock - MPU-isolated embedded OS in Rust",
          "url": "https://github.com/tock/tock"
        },
        {
          "name": "oxidecomputer/hubris - statically configured task model",
          "url": "https://github.com/oxidecomputer/hubris"
        }
      ],
      "pitfall": "Adopting a C RTOS for its middleware, then writing Rust tasks that block inside FFI calls. The scheduler guarantees hold, but your task's latency does not.",
      "resources": [
        {
          "title": "RTIC book: scheduling model and resource ceilings",
          "url": "https://rtic.rs/2/book/en/",
          "kind": "docs"
        },
        {
          "title": "Embassy book: executor and task model",
          "url": "https://embassy.dev/book/",
          "kind": "docs"
        },
        {
          "title": "Tock: kernel and process isolation design",
          "url": "https://github.com/tock/tock",
          "kind": "repo"
        },
        {
          "title": "Hubris: static task model used in production",
          "url": "https://github.com/oxidecomputer/hubris",
          "kind": "repo"
        },
        {
          "title": "TECS/Rust: memory-safe component framework for embedded systems",
          "url": "https://arxiv.org/abs/2510.25270",
          "kind": "paper"
        }
      ]
    },
    {
      "id": "x19",
      "n": 19,
      "title": "Safety and reliability: watchdogs and fail-safe state",
      "minutes": 95,
      "level": "industry",
      "goal": "Design firmware that fails into a defined state: independent watchdog, captured reset cause, verified configuration, and fault injection to prove it.",
      "sections": [
        {
          "h": "A watchdog is a task-liveness proof",
          "p": [
            "Kicking a watchdog from a timer interrupt proves only that the timer interrupt runs - which is exactly the failure you will not have. The useful design is a liveness bitmap: every critical task sets its bit once per period, and the lowest-priority task kicks only when all bits are set, then clears them. A hung sensor task then starves the kick and the device resets, which is the behaviour you wanted.",
            "Prefer the independent watchdog (IWDG on STM32), clocked from its own low-speed oscillator, because a clock-tree misconfiguration cannot disable it. Window mode adds the other half: a kick that arrives too early is also a fault, which catches a task that spins faster than its period after a corrupted state."
          ],
          "code": "use core::sync::atomic::{AtomicU32, Ordering};\n\nconst ALL_TASKS: u32 = 0b111;\nstatic ALIVE: AtomicU32 = AtomicU32::new(0);\n\n/// Each task calls this once per period with its own bit.\nfn check_in(bit: u32) {\n    ALIVE.fetch_or(bit, Ordering::Relaxed);\n}\n\n/// Lowest-priority task, once per period: kick only if everyone checked in.\n/// `feed` is the HAL watchdog method (IWDG::feed on STM32), passed as a closure.\nfn kick_watchdog(mut feed: impl FnMut()) {\n    let seen = ALIVE.swap(0, Ordering::AcqRel);\n    if seen == ALL_TASKS {\n        feed();\n    }\n    // else: do not feed; let the watchdog reset the device\n}",
          "tip": "Let the watchdog expire on purpose during development, once, and verify the device recovers and records why. An untested watchdog is a decoration."
        },
        {
          "h": "Fail-safe is a hardware property",
          "p": [
            "The state a pin holds during reset, before any firmware runs, is set by pull resistors and external hardware - not by code. If a heater output floats high when the MCU is held in reset, no amount of Rust prevents the hazard. Specify the safe level in the schematic, add the resistor, and then have firmware drive the same level so there is no transient at boot.",
            "Record why the device reset before anything can overwrite it: read the reset flags, store them in a .uninit record with a magic word, and increment a boot counter. A field unit that resets twice a day with no record is undebuggable; the same unit with \"watchdog, 41 times since install\" is a support ticket with an owner."
          ],
          "list": [
            "Safe state defined by hardware pull resistors, then matched by firmware at boot",
            "Reset cause captured before any peripheral init can clear the flags",
            "Boot counter and last fault stored in .uninit with a magic word",
            "Brown-out detection enabled at a level above the flash write minimum"
          ]
        },
        {
          "h": "Verified configuration and fault injection",
          "p": [
            "Store calibration and configuration with a version, a length and a CRC, in two copies with a sequence number so a power cut mid-write leaves the previous copy valid. On boot, validate and fall back to defaults with a logged reason rather than trusting whatever is in flash.",
            "Then attack it. Short the I2C lines while running. Pull the power at random points during a flash write, a hundred times. Fill the RX queue and see whether the drop path is exercised. Run the device for a week at temperature. Reliability claims that survive only happy-path testing are wishes; the failures you find on the bench are the ones your customers will not."
          ],
          "code": "#[repr(C)]\nstruct Config {\n    magic: u32,\n    version: u16,\n    len: u16,\n    crc: u32,\n    seq: u32,\n    payload: [u8; 64],\n}\n\nfn load_config(copies: [&Config; 2]) -> Option<&Config> {\n    let mut best: Option<&Config> = None;\n    for c in copies {\n        if c.magic != 0x434F_4E46 || c.len as usize != c.payload.len() {\n            continue;\n        }\n        if crc32(&c.payload) != c.crc {\n            continue;\n        }\n        if best.map_or(true, |b| c.seq.wrapping_sub(b.seq) < 0x8000_0000) {\n            best = Some(c); // newer sequence number wins\n        }\n    }\n    best\n}\n\nfn crc32(bytes: &[u8]) -> u32 {\n    let mut crc = 0xFFFF_FFFFu32;\n    for b in bytes {\n        crc ^= *b as u32;\n        for _ in 0..8 {\n            let mask = (crc & 1).wrapping_neg();\n            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);\n        }\n    }\n    !crc\n}"
        }
      ],
      "exercise": {
        "prompt": "Add a reset-cause record that survives a watchdog reset and distinguishes power-on, watchdog, and hard fault, then expose it as one telemetry field.",
        "starter": "#[link_section = \".uninit\"]\nstatic mut RESETS: ResetRecord = ResetRecord { magic: 0, counts: [0; 3] };\n\nfn boot() { todo!() }",
        "hint": "Check the magic word for cold boot, read the RCC reset flags before clearing them, classify into an index, increment that counter, then clear the flags. Return the index for telemetry.",
        "solution": "use core::sync::atomic::{AtomicU8, Ordering};\n\n#[repr(C)]\nstruct ResetRecord {\n    magic: u32,\n    counts: [u32; 3],\n}\n\n#[link_section = \".uninit\"]\n#[used]\nstatic mut RESETS: ResetRecord = ResetRecord { magic: 0, counts: [0; 3] };\n\nconst MAGIC: u32 = 0x5253_5452; // \"RSTR\"\nstatic LAST_CAUSE: AtomicU8 = AtomicU8::new(0);\n\n#[derive(Clone, Copy)]\n#[repr(u8)]\npub enum ResetCause {\n    PowerOn = 0,\n    Watchdog = 1,\n    HardFault = 2,\n}\n\n/// Call as the very first statement in main.\npub fn record_reset(csr: u32, iwdg_flag: bool) -> ResetCause {\n    // SAFETY: called once, before any other access to RESETS.\n    let rec = unsafe { &mut *core::ptr::addr_of_mut!(RESETS) };\n    if rec.magic != MAGIC {\n        rec.magic = MAGIC;\n        rec.counts = [0; 3];\n    }\n\n    let cause = if iwdg_flag {\n        ResetCause::Watchdog\n    } else if csr & (1 << 1) != 0 {\n        // hard-fault lockup bit in the classic RCC_CSR layout\n        ResetCause::HardFault\n    } else {\n        ResetCause::PowerOn\n    };\n\n    rec.counts[cause as usize] = rec.counts[cause as usize].saturating_add(1);\n    LAST_CAUSE.store(cause as u8, Ordering::Relaxed);\n    cause\n}\n\npub fn last_cause() -> u8 {\n    LAST_CAUSE.load(Ordering::Relaxed)\n}"
      },
      "questions": [
        {
          "q": "Why is feeding the watchdog from a timer interrupt a weak design?",
          "options": [
            "Interrupts are too slow to feed it",
            "It only proves the timer ISR runs, not that the work it supervises completed",
            "The watchdog clock stops in sleep",
            "It causes priority inversion"
          ],
          "answer": 1,
          "explain": "A timer keeps firing even when the consumer behind it is stuck. Task check-in bits prove the work advanced, which is what a watchdog should guard."
        },
        {
          "q": "Where is the fail-safe state of an output really defined?",
          "options": [
            "In the first line of main",
            "In hardware pull resistors and the pin state during reset, which firmware must then match",
            "In the linker script",
            "In the watchdog configuration"
          ],
          "answer": 1,
          "explain": "Firmware cannot run during reset or a crash. The defined state comes from external components; code can only avoid a transient when it takes over."
        },
        {
          "q": "Why keep two configuration copies with sequence numbers instead of one plus a backup?",
          "options": [
            "Flash is cheaper in pairs",
            "A power cut during a write leaves one copy with a valid CRC, and the sequence number identifies the newest",
            "CRC cannot detect errors in a single copy",
            "It halves the write time"
          ],
          "answer": 1,
          "explain": "Atomic updates need an old-valid plus new-valid state. The CRC rejects torn writes and the sequence number orders the survivors."
        }
      ],
      "quickbytes": [
        "Liveness bits beat a single feed call: the watchdog should prove every critical task advanced.",
        "Read and store reset flags before any init sequence clears them.",
        "Test the watchdog by hanging a task on purpose and confirming recovery plus a recorded cause.",
        "Dual config copies with magic, length, CRC and sequence beat one blob you trust."
      ],
      "production": [
        "The watchdog has a written liveness policy and is disabled only in a documented debug build.",
        "Reset cause and boot count are exported in telemetry and survive power loss.",
        "Configuration is versioned, CRC-checked and dual-banked, with a defined fallback behaviour.",
        "Fault injection - shorted buses, power cuts during writes, full queues - is part of release testing."
      ],
      "crates": [
        "embedded-hal",
        "cortex-m",
        "defmt"
      ],
      "github": [
        {
          "name": "rust-embedded/cortex-m - SCB fault handling and MPU",
          "url": "https://github.com/rust-embedded/cortex-m"
        }
      ],
      "pitfall": "A watchdog fed unconditionally in the idle task. It never fires, the device appears reliable, and every unresponsive-field-unit report is dismissed as \"network trouble\".",
      "resources": [
        {
          "title": "embassy-stm32 wdg: independent watchdog driver",
          "url": "https://docs.rs/embassy-stm32/latest/embassy_stm32/wdg/index.html",
          "kind": "docs"
        },
        {
          "title": "cortex-m: HardFault handling, SCB, MPU",
          "url": "https://docs.rs/cortex-m/latest/cortex_m/",
          "kind": "docs"
        },
        {
          "title": "Is Rust Used Safely by Software Developers?",
          "url": "https://arxiv.org/abs/2007.00752",
          "kind": "paper"
        },
        {
          "title": "The Embedded Rust Book: panicking and fault handling",
          "url": "https://github.com/rust-embedded/book",
          "kind": "repo"
        }
      ]
    },
    {
      "id": "x20",
      "n": 20,
      "title": "Firmware updates: A/B partitions, signing, rollback",
      "minutes": 110,
      "level": "industry",
      "goal": "Ship an update path that survives a power cut at any byte: A/B partitions, verified images, trial boot, and a rollback that actually works.",
      "sections": [
        {
          "h": "Four partitions and one state word",
          "p": [
            "embassy-boot divides flash into four regions: the bootloader, the active application, the DFU (download) area, and a state partition recording whether a swap is pending. Partitions must be page-aligned and sized in whole pages. The bootloader runs first, inspects the state, and either boots the active image or performs the swap.",
            "This layout is what makes a power cut survivable. The new image is written into DFU while the active image stays untouched, so the worst case at any point is \"the update did not happen\". The failure mode you must design out is a swap that is interrupted halfway: the state partition needs a progress marker so the bootloader can resume or revert deterministically instead of leaving a half-copied image."
          ],
          "code": "// flash layout, page size 2 KiB, 512 KiB total\n// 0x08000000  bootloader        32 KiB\n// 0x08008000  active            224 KiB\n// 0x08040000  DFU               224 KiB\n// 0x08078000  bootloader state    2 KiB (one page, erase before write)\n//\n// The application links at ACTIVE, the bootloader at 0x08000000.\n// Every region is a multiple of the page size, and the state page is\n// the only place the bootloader writes metadata.",
          "tip": "Write the partition table down before the first line of the updater. Moving a partition after release means a field recall or a permanently bricked cohort."
        },
        {
          "h": "Verify, then commit",
          "p": [
            "The updater writes chunks into DFU and computes a digest as it goes. Before marking the update bootable, verify that digest - and the signature, if you sign images - against the length that will be executed. Only then set the state to swap. Verifying after marking is a bug: a corrupted image that boots is worse than a failed update.",
            "Signing adds authenticity, not just integrity. A SHA-256 digest catches corruption; an Ed25519 or ECDSA signature over that digest proves the image came from you. Verify with a public key stored in the bootloader, and keep an anti-rollback counter so an attacker cannot reinstall a known-vulnerable signed image."
          ],
          "code": "use embassy_boot::{FirmwareUpdater, FirmwareUpdaterConfig};\n\npub async fn apply_update<F>(\n    config: FirmwareUpdaterConfig<F, F>,\n    image: &[u8],\n) -> Result<(), embassy_boot::FirmwareUpdaterError>\nwhere\n    F: embedded_storage_async::nor_flash::NorFlash,\n{\n    // AlignedBuffer is 32-byte aligned; size is a multiple of WRITE_SIZE.\n    let mut aligned = embassy_boot::AlignedBuffer([0u8; 4096]);\n    let mut updater = FirmwareUpdater::new(config, &mut aligned.0);\n\n    for (i, chunk) in image.chunks(4096).enumerate() {\n        updater.write_firmware(i * 4096, chunk).await?;\n    }\n\n    // Digest check before the image is allowed to boot.\n    // updater.hash::<Sha256>(image.len() as u32, &mut buf, &mut digest).await?;\n\n    updater.mark_updated().await?; // swap on next boot\n    Ok(())\n}\n\n// After a successful self-test on the new image:\n// updater.mark_booted().await?;  // cancels rollback",
          "tip": "mark_booted belongs after a self-test that exercises the radio and the sensors, not at the top of main. An image that boots but cannot transmit should roll back."
        },
        {
          "h": "Trial boot, rollback and the transport",
          "p": [
            "A swapped image boots in trial mode. If the application does not call mark_booted before the next reset, the bootloader reverts to the previous image. That is the mechanism that saves a device from an update that crashes on a hardware variant you did not test. The self-test window should be short enough to fail fast and long enough to prove the peripherals that matter.",
            "The transport is the last piece: chunked writes with retries, a persisted offset so a dropped connection resumes instead of restarting, and a size limit checked before the first erase. Flash writes need alignment to the NorFlash write size and erases to the page size; a chunk size that is not a multiple of both will fail on some part, some day."
          ],
          "list": [
            "Persist the write offset so an interrupted download resumes",
            "Check image length and version before erasing anything",
            "Verify digest and signature before mark_updated",
            "Self-test, then mark_booted; otherwise roll back automatically",
            "Keep the bootloader itself updatable, or make it immutable and verified"
          ]
        }
      ],
      "exercise": {
        "prompt": "Design the update state machine and write the resume logic: given a persisted offset and a chunked transport, write firmware so a power loss at any point either resumes or cleanly aborts, never boots a partial image.",
        "starter": "pub struct UpdateState { pub offset: u32, pub total: u32, pub crc: u32 }\n\npub async fn update(/* ... */) -> Result<(), ()> { todo!() }",
        "hint": "Persist offset only after each chunk is written and read back. On boot, if offset > 0 and offset < total, continue from there rather than restarting. Only mark_updated when offset == total and the digest matches.",
        "solution": "use embedded_storage_async::nor_flash::NorFlash;\n\npub struct UpdateState {\n    pub offset: u32,\n    pub total: u32,\n    pub digest: [u8; 32],\n}\n\npub enum Outcome {\n    Complete,\n    Resumed(u32),\n    Rejected(&'static str),\n}\n\n/// Resume-capable update. `state` is persisted in the state partition\n/// after every successfully written chunk.\npub async fn update<F, T>(\n    flash: &mut F,\n    transport: &mut T,\n    state: &mut UpdateState,\n    image_len: u32,\n    chunk: usize,\n) -> Result<Outcome, ()>\nwhere\n    F: NorFlash,\n    T: ChunkSource,\n{\n    if image_len == 0 || image_len > state.total {\n        return Ok(Outcome::Rejected(\"image length out of range\"));\n    }\n\n    let resumed = state.offset > 0;\n    let mut buf = [0u8; 4096];\n\n    while state.offset < image_len {\n        let want = core::cmp::min(chunk as u32, image_len - state.offset) as usize;\n        let n = transport.read_at(state.offset, &mut buf[..want]).await.map_err(|_| ())?;\n        if n == 0 {\n            break; // link dropped: keep the offset, resume later\n        }\n\n        flash.write(state.offset, &buf[..n]).await.map_err(|_| ())?;\n        state.offset += n as u32;\n        // persist state.offset here, before requesting the next chunk\n    }\n\n    if state.offset == image_len {\n        Ok(Outcome::Complete) // caller verifies digest, then mark_updated\n    } else if resumed {\n        Ok(Outcome::Resumed(state.offset))\n    } else {\n        Ok(Outcome::Rejected(\"incomplete image\"))\n    }\n}\n\npub trait ChunkSource {\n    async fn read_at(&mut self, offset: u32, out: &mut [u8]) -> Result<usize, ()>;\n}"
      },
      "questions": [
        {
          "q": "Why must the digest be verified before mark_updated?",
          "options": [
            "Because verification is faster before the swap",
            "So a corrupted or truncated image is never allowed to become bootable",
            "Because the bootloader cannot read flash",
            "Because the digest changes after the swap"
          ],
          "answer": 1,
          "explain": "Marking first and verifying later allows a partial image to boot. Verification gates the swap; it does not follow it."
        },
        {
          "q": "What does mark_booted do?",
          "options": [
            "Erases the DFU partition after a successful update",
            "Cancels rollback, confirming the new image passed its self-test",
            "Restarts the bootloader",
            "Recomputes the image signature"
          ],
          "answer": 1,
          "explain": "A swapped image boots in trial mode. mark_booted commits it; without that call the bootloader reverts on the next reset."
        },
        {
          "q": "A field unit loses power mid-download. What must the design guarantee?",
          "options": [
            "The download restarts from zero",
            "The active image is untouched and the update resumes from the persisted offset",
            "The bootloader is rewritten",
            "The device enters DFU mode permanently"
          ],
          "answer": 1,
          "explain": "Writes go to DFU, never to the active partition. A persisted offset means an interrupted update costs time, not a brick."
        }
      ],
      "quickbytes": [
        "Write to DFU, never to the running image; the worst case must be \"no update\".",
        "Verify digest and signature before mark_updated, and mark_booted only after self-test.",
        "Persist the write offset after each chunk so a dropped link resumes.",
        "Test with power cuts at random offsets, repeatedly; that is the only proof of power-fail safety."
      ],
      "production": [
        "The partition table is fixed, page-aligned and documented before release.",
        "Images are signed, and the bootloader verifies with a key it owns, with an anti-rollback counter.",
        "A trial boot plus self-test gates commit; a failed self-test rolls back on the next reset.",
        "Power-cut injection during updates is a release test, not an afterthought.",
        "Every device reports its running image version in telemetry so rollout can be measured."
      ],
      "crates": [
        "embassy-boot",
        "embedded-storage",
        "embedded-storage-async",
        "ed25519-dalek"
      ],
      "github": [
        {
          "name": "embassy-rs/embassy - embassy-boot A/B bootloader",
          "url": "https://github.com/embassy-rs/embassy/tree/main/embassy-boot"
        },
        {
          "name": "mcu-tools/mcuboot - widely deployed secure bootloader",
          "url": "https://github.com/mcu-tools/mcuboot"
        }
      ],
      "pitfall": "Marking the update bootable as soon as the last chunk is written. One corrupted byte then boots, fails the self-test, and there is no previous image left to roll back to.",
      "resources": [
        {
          "title": "embassy-boot: partitions, swap state and rollback",
          "url": "https://docs.rs/embassy-boot/latest/embassy_boot/",
          "kind": "docs"
        },
        {
          "title": "embassy-boot source and linker scripts",
          "url": "https://github.com/embassy-rs/embassy/tree/main/embassy-boot",
          "kind": "repo"
        },
        {
          "title": "MCUboot: image format, signing and swap algorithms",
          "url": "https://github.com/mcu-tools/mcuboot",
          "kind": "repo"
        },
        {
          "title": "detools: binary delta patches for firmware",
          "url": "https://github.com/eerimoq/detools",
          "kind": "repo"
        }
      ]
    }
  ]
};
