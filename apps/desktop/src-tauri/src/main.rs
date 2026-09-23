// Windows'ta release sürümde konsol penceresi açılmasın
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kavsak_desktop_lib::run()
}
