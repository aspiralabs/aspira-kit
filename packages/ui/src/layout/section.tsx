import { cn } from '../lib/cn.js';
import { ReactNode } from 'react';

export interface SectionHeaderConfig {
    /** Serif section title. */
    title: string;
    /** Optional sans-serif subheader. */
    description?: string;
}

/**
 * `Section` is the canonical in-page grouping: a serif `Section.Header` (with an
 * optional sans-serif description and a right-aligned `Section.Actions` slot)
 * above a `Section.Content` body. Stack multiple `Section`s with `space-y-12`.
 *
 *   <Section>
 *     <Section.Header config={{ title, description }}>
 *       <Section.Actions><Button /></Section.Actions>
 *     </Section.Header>
 *     <Section.Content>{...}</Section.Content>
 *   </Section>
 */
function Section({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn('flex flex-col gap-6 w-full', className)}>{children}</div>;
}

/** Right-aligned action slot for `Section.Header` (buttons, menus, badges). */
function Actions({ children }: { children: ReactNode }) {
    return <>{children}</>;
}
Actions.displayName = 'Section.Actions';

function Header({ config, children }: { config: SectionHeaderConfig; children?: ReactNode }) {
    const { title, description } = config;

    return (
        <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
                <h2 className="text-3xl font-serif text-foreground">{title}</h2>
                {description && (
                    <p className="text-base text-foreground-subtext">{description}</p>
                )}
            </div>
            {children && <div className="flex items-center gap-3 shrink-0">{children}</div>}
        </div>
    );
}
Header.displayName = 'Section.Header';

function Content({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn('flex-1 w-full', className)}>{children}</div>;
}
Content.displayName = 'Section.Content';

Section.Header = Header;
Section.Actions = Actions;
Section.Content = Content;

export { Section, Header as SectionHeader, Actions as SectionActions, Content as SectionContent };
