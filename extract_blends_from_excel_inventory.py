#!/usr/bin/env python3
"""
Regenerate all blend files in the new simplified format
Format: "- count× name" for all resource types
"""
import openpyxl
from pathlib import Path
from collections import Counter

def regenerate_all_blends():
    excel_path = Path(__file__).parent / "Dune_Imperium_Card_Inventory.xlsx"
    blends_dir = Path(__file__).parent / "blends"
    blends_dir.mkdir(exist_ok=True)

    print(f"Loading {excel_path}")
    wb = openpyxl.load_workbook(excel_path, data_only=True)

    # Resource type configurations
    resource_sheets = {
        'Imperium': 'Imperium Cards',
        'Intrigue': 'Intrigue Cards',
        'Tleilax': 'Tleilax Cards',
        'Reserve': 'Reserve Cards',
        'Tech': 'Tech Tiles',
        'Contracts': 'Contracts',
        'Leader': 'Leaders',
        'Sardaukar': 'Sardaukar',
        'Starter': 'Starter Cards',
        'Conflict': 'Conflict Cards'
    }

    # For custom blends (Merakon and TragicJonson)
    merakon_resources = {sheet: [] for sheet in resource_sheets.values()}
    tragic_resources = {sheet: [] for sheet in resource_sheets.values()}

    # Process each worksheet
    for sheet_name, display_name in resource_sheets.items():
        if sheet_name not in wb.sheetnames:
            print(f"  Skipping {sheet_name} (not found)")
            continue

        ws = wb[sheet_name]
        headers = [cell.value for cell in ws[1]]

        # Find name column (first column usually)
        name_col = headers[0] if headers else "Card Name"

        # Find blend columns if they exist
        merakon_col = "Count in Merakon's House Blend"
        tragic_col = "Count in TragicJonson's House Blend"

        merakon_idx = headers.index(merakon_col) if merakon_col in headers else None
        tragic_idx = headers.index(tragic_col) if tragic_col in headers else None

        for row in ws.iter_rows(min_row=2, values_only=True):
            row_dict = dict(zip(headers, row))
            resource_name = str(row_dict.get(name_col, '')).strip()
            if not resource_name:
                continue

            # Normalize card names: replace (Base) with (Imperium)
            resource_name = resource_name.replace('(Base)', '(Imperium)')

            # Add to Merakon's blend if count exists
            if merakon_idx is not None:
                merakon_count = row_dict.get(merakon_col, 0)
                if merakon_count and str(merakon_count).strip() not in ['', '0', '0.0']:
                    try:
                        count = int(float(merakon_count))
                        if count > 0:
                            for _ in range(count):
                                merakon_resources[display_name].append(resource_name)
                    except (ValueError, TypeError):
                        pass

            # Add to TragicJonson's blend if count exists
            if tragic_idx is not None:
                tragic_count = row_dict.get(tragic_col, 0)
                if tragic_count and str(tragic_count).strip() not in ['', '0', '0.0']:
                    try:
                        count = int(float(tragic_count))
                        if count > 0:
                            for _ in range(count):
                                tragic_resources[display_name].append(resource_name)
                    except (ValueError, TypeError):
                        pass

    # Create Merakon's blend (uses Uprising board)
    if any(merakon_resources.values()):
        filepath = blends_dir / "Merakons_House_Blend.md"
        create_multi_resource_blend_file(filepath, "Merakon's House Blend", merakon_resources,
                                        description="", board="uprising")
        total = sum(len(items) for items in merakon_resources.values())
        print(f"✓ Created Merakon's House Blend with {total} total items")

    # Create TragicJonson's blend (uses Uprising board)
    if any(tragic_resources.values()):
        filepath = blends_dir / "TragicJonsons_House_Blend.md"
        create_multi_resource_blend_file(filepath, "TragicJonson's House Blend", tragic_resources,
                                        description="", board="uprising")
        total = sum(len(items) for items in tragic_resources.values())
        print(f"✓ Created TragicJonson's House Blend with {total} total items")

    # Create Base Imperium and Base Uprising
    create_base_blends(wb, resource_sheets)


def create_base_blends(wb, resource_sheets):
    """Create Base Imperium and Base Uprising blends."""
    base_imperium_resources = {}
    base_uprising_resources = {}

    for sheet_name, display_name in resource_sheets.items():
        if sheet_name not in wb.sheetnames:
            continue

        ws = wb[sheet_name]
        headers = [cell.value for cell in ws[1]]
        name_col = headers[0] if headers else "Card Name"

        base_imperium_items = []
        base_uprising_items = []

        for row in ws.iter_rows(min_row=2, values_only=True):
            row_dict = dict(zip(headers, row))
            resource_name = str(row_dict.get(name_col, '')).strip()
            if not resource_name:
                continue

            # Normalize card names: replace (Base) with (Imperium)
            resource_name = resource_name.replace('(Base)', '(Imperium)')

            source = str(row_dict.get("Source", "Imperium")).strip()
            # Handle different count column names (Starter uses "Count per Player")
            count = row_dict.get("Count") or row_dict.get("Count per Player") or 1

            try:
                item_count = int(float(count)) if count else 1
            except (ValueError, TypeError):
                item_count = 1

            if source == "Imperium" or source == "Base":
                for _ in range(item_count):
                    base_imperium_items.append(resource_name)
            elif source == "Uprising":
                for _ in range(item_count):
                    base_uprising_items.append(resource_name)

        if base_imperium_items:
            base_imperium_resources[display_name] = base_imperium_items
        if base_uprising_items:
            base_uprising_resources[display_name] = base_uprising_items

    # Save Base Imperium (uses imperium board)
    if base_imperium_resources:
        filepath = Path(__file__).parent / "blends" / "Base_Imperium.md"
        create_multi_resource_blend_file(filepath, "Base Imperium", base_imperium_resources,
                                        "All cards from the Base Game", board="imperium")
        total = sum(len(items) for items in base_imperium_resources.values())
        print(f"✓ Created Base Imperium with {total} total items")

    # Save Base Uprising (uses uprising board)
    if base_uprising_resources:
        filepath = Path(__file__).parent / "blends" / "Base_Uprising.md"
        create_multi_resource_blend_file(filepath, "Base Uprising", base_uprising_resources,
                                        "All cards from the Uprising expansion", board="uprising")
        total = sum(len(items) for items in base_uprising_resources.values())
        print(f"✓ Created Base Uprising with {total} total items")


def create_multi_resource_blend_file(filepath, blend_name, resources_by_type, description="", board="imperium", additional_boards=None):
    """Create a blend file with multiple resource types in simplified format."""
    md = f"# {blend_name}\n\n"

    # Add board selection at the top
    md += f"## Board\n\n"
    md += f"- Main Board: {board}\n"
    if additional_boards:
        md += f"- Additional Boards: {', '.join(additional_boards)}\n"
    md += "\n"

    if description:
        md += f"*{description}*\n\n"

    total_items = sum(len(items) for items in resources_by_type.values())
    md += f"**Total Items:** {total_items}\n\n"

    # Add each resource type section
    for resource_type, items in resources_by_type.items():
        if not items:
            continue

        md += f"## {resource_type}\n\n"

        # Count occurrences
        item_counts = Counter(items)

        # Sort by name and output
        for item_name in sorted(item_counts.keys()):
            count = item_counts[item_name]
            if count == 1:
                md += f"- {item_name}\n"
            else:
                md += f"- {count}× {item_name}\n"

        md += "\n"

    md += "---\n*Generated by Dune Imperium Blend Builder*\n"

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(md)


if __name__ == '__main__':
    regenerate_all_blends()
    print("\n✓ All blend files regenerated with all resource types!")

