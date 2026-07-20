use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::Command;

fn assert_documented(command: &Command, path: &[String]) {
    let invocation = path.join(" ");
    assert!(
        command.get_about().is_some(),
        "visible command `{invocation}` is missing about text"
    );
    for argument in command
        .get_arguments()
        .filter(|argument| !argument.is_hide_set())
    {
        assert!(
            argument.get_help().is_some(),
            "visible argument `{}` on `{invocation}` is missing help text",
            argument.get_id()
        );
    }
    for subcommand in command
        .get_subcommands()
        .filter(|subcommand| !subcommand.is_hide_set() && subcommand.get_name() != "help")
    {
        let mut subcommand_path = path.to_vec();
        subcommand_path.push(subcommand.get_name().to_string());
        assert_documented(subcommand, &subcommand_path);
    }
}

fn collect_pages(command: &Command, path: &[String], pages: &mut BTreeMap<String, Vec<u8>>) {
    let page_name = path.join("-");
    let invocation = path.join(" ");
    let mut page_command = command.clone().name(page_name.clone()).bin_name(invocation);
    for subcommand in page_command
        .get_subcommands_mut()
        .filter(|subcommand| subcommand.get_name() == "help")
    {
        *subcommand = subcommand.clone().hide(true);
    }
    page_command.build();

    let mut rendered = Vec::new();
    clap_mangen::Man::new(page_command)
        .render(&mut rendered)
        .expect("render man page");
    let rendered = String::from_utf8(rendered)
        .expect("man page is UTF-8")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    pages.insert(format!("{page_name}.1"), rendered.into_bytes());

    for subcommand in command
        .get_subcommands()
        .filter(|subcommand| !subcommand.is_hide_set() && subcommand.get_name() != "help")
    {
        let mut subcommand_path = path.to_vec();
        subcommand_path.push(subcommand.get_name().to_string());
        collect_pages(subcommand, &subcommand_path, pages);
    }
}

fn expected_pages() -> BTreeMap<String, Vec<u8>> {
    let mut command = rom_weaver_app::cli_command();
    command.build();
    let root = command.get_name().to_string();
    assert_documented(&command, std::slice::from_ref(&root));
    let mut pages = BTreeMap::new();
    collect_pages(&command, &[root], &mut pages);
    pages
}

fn output_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/man")
}

fn write_pages(output_dir: &Path, pages: &BTreeMap<String, Vec<u8>>) -> std::io::Result<()> {
    fs::create_dir_all(output_dir)?;
    for entry in fs::read_dir(output_dir)? {
        let path = entry?.path();
        let is_man_page = path.extension().is_some_and(|extension| extension == "1");
        let is_expected = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| pages.contains_key(name));
        if is_man_page && !is_expected {
            fs::remove_file(path)?;
        }
    }
    for (name, contents) in pages {
        fs::write(output_dir.join(name), contents)?;
    }
    Ok(())
}

fn check_pages(output_dir: &Path, pages: &BTreeMap<String, Vec<u8>>) -> std::io::Result<bool> {
    let actual_names = if output_dir.is_dir() {
        fs::read_dir(output_dir)?
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.ends_with(".1"))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let names_match = actual_names.len() == pages.len()
        && actual_names.iter().all(|name| pages.contains_key(name));
    let contents_match = pages.iter().all(|(name, expected)| {
        fs::read(output_dir.join(name)).is_ok_and(|actual| actual == *expected)
    });
    Ok(names_match && contents_match)
}

fn main() -> ExitCode {
    let mode = env::args().nth(1).unwrap_or_else(|| "--write".to_string());
    let pages = expected_pages();
    let output_dir = output_dir();
    match mode.as_str() {
        "--write" => match write_pages(&output_dir, &pages) {
            Ok(()) => {
                println!(
                    "generated {} man pages in {}",
                    pages.len(),
                    output_dir.display()
                );
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("failed to generate man pages: {error}");
                ExitCode::FAILURE
            }
        },
        "--check" => match check_pages(&output_dir, &pages) {
            Ok(true) => {
                println!("{} generated man pages are up to date", pages.len());
                ExitCode::SUCCESS
            }
            Ok(false) => {
                eprintln!(
                    "generated man pages are stale; run `cargo run -p rom-weaver-cli --example generate_manpages -- --write`"
                );
                ExitCode::FAILURE
            }
            Err(error) => {
                eprintln!("failed to check generated man pages: {error}");
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("usage: generate_manpages [--write|--check]");
            ExitCode::from(2)
        }
    }
}
