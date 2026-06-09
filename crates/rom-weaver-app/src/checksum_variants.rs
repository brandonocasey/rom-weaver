use super::*;

const CHECKSUM_VARIANT_CHUNK_SIZE: usize = 1024 * 1024;

#[derive(Clone, Debug)]
struct ChecksumVariantDefinition {
    id: String,
    label: String,
    apply_compatibility: Value,
    transforms: Value,
    kind: ChecksumVariantKind,
}

#[derive(Clone, Debug)]
enum ChecksumVariantKind {
    Raw,
    RemoveHeader {
        stripped_bytes: u64,
    },
    FixHeader {
        overlay: SparseChecksumRepairPlan,
    },
    N64ByteOrder {
        source_order: N64ByteOrder,
        target_order: N64ByteOrder,
    },
}

#[derive(Clone, Debug)]
struct SparseChecksumRepairPlan {
    patches: BTreeMap<u64, Vec<u8>>,
    repaired_profiles: Vec<&'static str>,
}

struct ActiveChecksumVariant {
    definition: ChecksumVariantDefinition,
    checksum: StreamingChecksum,
}

impl CliApp {
    pub(super) fn run_checksum_variants_with_progress<F>(
        &self,
        request: &ChecksumRequest,
        context: &OperationContext,
        stage: &'static str,
        on_progress: &mut F,
    ) -> Result<OperationReport>
    where
        F: FnMut(ChecksumProgress),
    {
        let algorithms = request
            .algorithms
            .iter()
            .map(|algorithm| algorithm.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let definitions = self.build_checksum_variant_definitions(&request.source)?;
        let file_len = fs::metadata(&request.source)?.len();
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        let mut active = Vec::with_capacity(definitions.len());
        for definition in definitions {
            let Some(checksum) = StreamingChecksum::new(&algorithms)? else {
                continue;
            };
            active.push(ActiveChecksumVariant {
                definition,
                checksum,
            });
        }

        let mut file = File::open(&request.source)?;
        let mut remaining = file_len;
        let mut offset = 0_u64;
        let mut buffer = vec![0_u8; CHECKSUM_VARIANT_CHUNK_SIZE];
        let mut next_percent = 1_u64;
        while remaining > 0 {
            context.cancel().check()?;
            let limit = remaining.min(buffer.len() as u64) as usize;
            file.read_exact(&mut buffer[..limit])?;
            let chunk = &buffer[..limit];
            for variant in &mut active {
                Self::update_checksum_variant(variant, offset, chunk)?;
            }
            offset = offset.saturating_add(limit as u64);
            remaining -= limit as u64;
            Self::emit_checksum_variant_progress(offset, file_len, &mut next_percent, on_progress);
        }
        on_progress(ChecksumProgress {
            processed_bytes: file_len,
            total_bytes: file_len,
        });

        let mut primary_checksums = BTreeMap::new();
        let mut rows = Vec::with_capacity(active.len());
        for variant in active {
            let checksums = variant.checksum.finalize()?;
            if variant.definition.id == "raw" {
                primary_checksums = checksums.clone();
            }
            rows.push(json!({
                "id": variant.definition.id,
                "label": variant.definition.label,
                "checksums": checksums,
                "applyCompatibility": variant.definition.apply_compatibility,
                "transforms": variant.definition.transforms,
            }));
        }

        let mut report = OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            stage,
            Self::render_checksum_details_label(&algorithms, &primary_checksums),
            Some(100.0),
            Some(execution),
        );
        report.details = Some(json!({
            "checksums": primary_checksums,
            "checksum_variants": rows,
        }));
        Ok(report)
    }

    pub(super) fn attach_checksum_details(
        mut report: OperationReport,
        checksums: BTreeMap<String, String>,
    ) -> OperationReport {
        let mut details = match report.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        details.insert("checksums".to_string(), json!(checksums.clone()));
        details.insert(
            "checksum_variants".to_string(),
            json!([{
                "id": "raw",
                "label": "Raw",
                "checksums": checksums,
                "applyCompatibility": {},
                "transforms": {},
            }]),
        );
        report.details = Some(Value::Object(details));
        report
    }

    fn build_checksum_variant_definitions(
        &self,
        source: &Path,
    ) -> Result<Vec<ChecksumVariantDefinition>> {
        let mut definitions = vec![ChecksumVariantDefinition {
            id: "raw".to_string(),
            label: "Raw".to_string(),
            apply_compatibility: json!({}),
            transforms: json!({}),
            kind: ChecksumVariantKind::Raw,
        }];

        if let Ok(header_match) = Self::detect_strippable_rom_header(source)
            && let Some(stripped_bytes) = header_match.stripped_bytes()
        {
            definitions.push(ChecksumVariantDefinition {
                id: "remove-header".to_string(),
                label: "Remove header".to_string(),
                apply_compatibility: json!({
                    "removeHeader": true,
                    "strip_header": true,
                }),
                transforms: json!({
                    "removeHeader": {
                        "profile": header_match.profile_name(),
                        "strippedBytes": stripped_bytes,
                    }
                }),
                kind: ChecksumVariantKind::RemoveHeader {
                    stripped_bytes: stripped_bytes as u64,
                },
            });
        }

        if let Some(overlay) = Self::plan_checksum_repair_overlay(source)? {
            definitions.push(ChecksumVariantDefinition {
                id: "fix-header".to_string(),
                label: "Fix header".to_string(),
                apply_compatibility: json!({
                    "fixChecksum": true,
                    "repair_checksum": true,
                }),
                transforms: json!({
                    "fixChecksum": {
                        "repairedProfiles": overlay.repaired_profiles.clone(),
                    }
                }),
                kind: ChecksumVariantKind::FixHeader { overlay },
            });
        }

        let file_len = fs::metadata(source)?.len();
        if file_len % 4 == 0
            && let Some(source_order) = Self::detect_n64_byte_order_path(source)?
        {
            for target_order in N64ByteOrder::ALL {
                definitions.push(ChecksumVariantDefinition {
                    id: format!("n64-byte-order:{}", target_order.id()),
                    label: format!("N64 byte order: {}", target_order.label()),
                    apply_compatibility: json!({
                        "n64ByteOrder": target_order.id(),
                        "n64_byte_order": target_order.id(),
                    }),
                    transforms: json!({
                        "n64ByteOrder": {
                            "detected": source_order.id(),
                            "sourceOrder": source_order.id(),
                            "targetOrder": target_order.id(),
                        }
                    }),
                    kind: ChecksumVariantKind::N64ByteOrder {
                        source_order,
                        target_order,
                    },
                });
            }
        }

        Ok(definitions)
    }

    fn update_checksum_variant(
        variant: &mut ActiveChecksumVariant,
        chunk_offset: u64,
        chunk: &[u8],
    ) -> Result<()> {
        match &variant.definition.kind {
            ChecksumVariantKind::Raw => variant.checksum.update(chunk),
            ChecksumVariantKind::RemoveHeader { stripped_bytes } => {
                let chunk_end = chunk_offset.saturating_add(chunk.len() as u64);
                if chunk_end <= *stripped_bytes {
                    return Ok(());
                }
                let start = stripped_bytes
                    .saturating_sub(chunk_offset)
                    .min(chunk.len() as u64) as usize;
                variant.checksum.update(&chunk[start..])
            }
            ChecksumVariantKind::FixHeader { overlay } => {
                Self::update_checksum_with_sparse_overlay(
                    &mut variant.checksum,
                    chunk_offset,
                    chunk,
                    overlay,
                )
            }
            ChecksumVariantKind::N64ByteOrder {
                source_order,
                target_order,
            } => Self::update_checksum_with_n64_byte_order(
                &mut variant.checksum,
                chunk,
                *source_order,
                *target_order,
            ),
        }
    }

    fn update_checksum_with_sparse_overlay(
        checksum: &mut StreamingChecksum,
        chunk_offset: u64,
        chunk: &[u8],
        overlay: &SparseChecksumRepairPlan,
    ) -> Result<()> {
        let chunk_end = chunk_offset.saturating_add(chunk.len() as u64);
        let mut patched = None;
        for (patch_offset, patch_bytes) in &overlay.patches {
            let patch_end = patch_offset.saturating_add(patch_bytes.len() as u64);
            if patch_end <= chunk_offset || *patch_offset >= chunk_end {
                continue;
            }
            let patched_chunk = patched.get_or_insert_with(|| chunk.to_vec());
            let write_start = patch_offset.saturating_sub(chunk_offset) as usize;
            let source_start = chunk_offset.saturating_sub(*patch_offset) as usize;
            let write_len =
                (patch_bytes.len() - source_start).min(patched_chunk.len() - write_start);
            patched_chunk[write_start..write_start + write_len]
                .copy_from_slice(&patch_bytes[source_start..source_start + write_len]);
        }
        if let Some(patched) = patched {
            checksum.update_owned(patched)
        } else {
            checksum.update(chunk)
        }
    }

    fn update_checksum_with_n64_byte_order(
        checksum: &mut StreamingChecksum,
        chunk: &[u8],
        source_order: N64ByteOrder,
        target_order: N64ByteOrder,
    ) -> Result<()> {
        if source_order == target_order {
            return checksum.update(chunk);
        }
        let mut transformed = Vec::with_capacity(chunk.len());
        for word in chunk.chunks_exact(4) {
            let mut bytes = [word[0], word[1], word[2], word[3]];
            Self::transform_n64_word(&mut bytes, source_order);
            Self::transform_n64_word(&mut bytes, target_order);
            transformed.extend_from_slice(&bytes);
        }
        checksum.update_owned(transformed)
    }

    fn emit_checksum_variant_progress<F>(
        processed_bytes: u64,
        total_bytes: u64,
        next_percent: &mut u64,
        on_progress: &mut F,
    ) where
        F: FnMut(ChecksumProgress),
    {
        if total_bytes == 0 {
            return;
        }
        let percent = processed_bytes
            .saturating_mul(100)
            .checked_div(total_bytes)
            .unwrap_or(100)
            .min(100);
        while *next_percent <= percent {
            on_progress(ChecksumProgress {
                processed_bytes,
                total_bytes,
            });
            *next_percent = (*next_percent).saturating_add(1);
        }
    }

    fn render_checksum_details_label(
        algorithms: &[String],
        checksums: &BTreeMap<String, String>,
    ) -> String {
        algorithms
            .iter()
            .filter_map(|algorithm| {
                checksums
                    .get(algorithm.as_str())
                    .map(|value| format!("{algorithm}={value}"))
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn plan_checksum_repair_overlay(source: &Path) -> Result<Option<SparseChecksumRepairPlan>> {
        let mut file = File::open(source)?;
        let file_len = usize::try_from(file.metadata()?.len()).map_err(|_| {
            RomWeaverError::Validation("header repair file length overflowed usize".into())
        })?;
        let mut plan = SparseChecksumRepairPlan {
            patches: BTreeMap::new(),
            repaired_profiles: Vec::new(),
        };
        Self::plan_gba_checksum_repair_overlay(&mut file, file_len, &mut plan)?;
        Self::plan_sega_genesis_checksum_repair_overlay(&mut file, file_len, &mut plan)?;
        Self::plan_n64_checksum_repair_overlay(&mut file, file_len, &mut plan)?;
        if plan.patches.is_empty() {
            Ok(None)
        } else {
            Ok(Some(plan))
        }
    }

    fn plan_gba_checksum_repair_overlay(
        file: &mut File,
        file_len: usize,
        plan: &mut SparseChecksumRepairPlan,
    ) -> Result<()> {
        if file_len < 0x1BE {
            return Ok(());
        }
        let header = Self::read_vec_at(file, 0, 0x1BE)?;
        if header[0x04..0x08] != GBA_HEADER_MAGIC {
            return Ok(());
        }
        let old_checksum = header[0x1BD];
        let mut checksum = 0_i32;
        for value in &header[0xA0..=0xBC] {
            checksum -= i32::from(*value);
        }
        let new_checksum = ((checksum - 0x19) & 0xFF) as u8;
        if old_checksum != new_checksum {
            plan.patches.insert(0x1BD, vec![new_checksum]);
            plan.repaired_profiles.push("gba");
        }
        Ok(())
    }

    fn plan_sega_genesis_checksum_repair_overlay(
        file: &mut File,
        file_len: usize,
        plan: &mut SparseChecksumRepairPlan,
    ) -> Result<()> {
        if file_len <= 0x18F || file_len < 0x200 {
            return Ok(());
        }
        let sega_probe = Self::read_vec_at(file, 0x100, 5)?;
        if sega_probe[0..4] != *b"SEGA" && sega_probe[1..5] != *b"SEGA" {
            return Ok(());
        }

        let old_checksum_bytes = Self::read_vec_at(file, 0x18E, 2)?;
        let old_checksum = u16::from_be_bytes([old_checksum_bytes[0], old_checksum_bytes[1]]);
        let sum = Self::sum_sega_words(file, 0x200, file_len)?;
        let new_checksum = (sum & 0xFFFF) as u16;
        if old_checksum != new_checksum {
            plan.patches
                .insert(0x18E, new_checksum.to_be_bytes().to_vec());
            plan.repaired_profiles.push("sega-genesis");
        }
        Ok(())
    }

    fn plan_n64_checksum_repair_overlay(
        file: &mut File,
        file_len: usize,
        plan: &mut SparseChecksumRepairPlan,
    ) -> Result<()> {
        if file_len < 0x101000 {
            return Ok(());
        }

        let Some(order) = Self::detect_n64_byte_order_file(file, file_len)? else {
            return Ok(());
        };

        let old_crc1 = Self::read_n64_word_normalized(file, 0x10, order)?;
        let old_crc2 = Self::read_n64_word_normalized(file, 0x14, order)?;

        let seed = 0xF8CA4DDCu32;
        let mut t1 = seed;
        let mut t2 = seed;
        let mut t3 = seed;
        let mut t4 = seed;
        let mut t5 = seed;
        let mut t6 = seed;

        for offset in (0x1000usize..0x101000usize).step_by(4) {
            let d = Self::read_n64_word_normalized(file, offset as u64, order)?;
            if t6.wrapping_add(d) < t6 {
                t4 = t4.wrapping_add(1);
            }
            t6 = t6.wrapping_add(d);
            t3 ^= d;

            let shift = d & 0x1F;
            let rotated = if shift == 0 { d } else { d.rotate_left(shift) };

            t5 = t5.wrapping_add(rotated);
            if t2 > d {
                t2 ^= rotated;
            } else {
                t2 ^= t6 ^ d;
            }
            t1 = t1.wrapping_add(t5 ^ d);
        }

        let new_crc1 = t6 ^ t4 ^ t3;
        let new_crc2 = t5 ^ t2 ^ t1;
        if old_crc1 != new_crc1 {
            plan.patches.insert(
                0x10,
                Self::n64_word_bytes_original_order(new_crc1, order).to_vec(),
            );
        }
        if old_crc2 != new_crc2 {
            plan.patches.insert(
                0x14,
                Self::n64_word_bytes_original_order(new_crc2, order).to_vec(),
            );
        }
        if old_crc1 != new_crc1 || old_crc2 != new_crc2 {
            plan.repaired_profiles.push("n64");
        }
        Ok(())
    }

    fn n64_word_bytes_original_order(value: u32, order: N64ByteOrder) -> [u8; 4] {
        let mut bytes = value.to_be_bytes();
        Self::transform_n64_word(&mut bytes, order);
        bytes
    }
}
