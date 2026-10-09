//! Behaviour of edits, validation, compaction and snapshots.

use ps_model::*;
use serde_json::json;

fn node(id: &str, kv: f64) -> Element {
    Element::Node(Node {
        id: id.into(),
        name: id.to_uppercase(),
        nominal_kv: kv,
        v_min: 0.9,
        v_max: 1.1,
        ..Default::default()
    })
}

fn line(id: &str, a: u32, b: u32) -> Element {
    Element::Line(Line {
        id: id.into(),
        node1: NodeRef(a),
        node2: NodeRef(b),
        in_service: true,
        r: 1.0,
        x: 10.0,
        ..Default::default()
    })
}

fn load(id: &str, at: u32, p: f64) -> Element {
    Element::Load(Load {
        id: id.into(),
        node: NodeRef(at),
        in_service: true,
        p,
        q: p / 4.0,
        p_zip: [0.0, 0.0, 1.0],
        q_zip: [0.0, 0.0, 1.0],
        ..Default::default()
    })
}

fn build() -> Result<(Model, IdIndex), OpError> {
    let mut m = Model::new("test");
    let mut ix = m.index();
    for e in [
        node("a", 132.0),
        node("b", 132.0),
        node("c", 132.0),
        line("ab", 0, 1),
        line("bc", 1, 2),
        load("l1", 2, 40.0),
    ] {
        m.apply(Op::Insert { element: e }, &mut ix)?;
    }
    Ok((m, ix))
}

#[test]
fn every_edit_is_undone_by_its_inverse() -> Result<(), OpError> {
    let (mut m, mut ix) = build()?;
    let before = m.clone();
    let edits = vec![
        Op::Set {
            class: Class::Load,
            id: "l1".into(),
            field: "p".into(),
            value: json!(55.5),
        },
        Op::Set {
            class: Class::Line,
            id: "ab".into(),
            field: "inService".into(),
            value: json!(false),
        },
        Op::Replace {
            element: line("bc", 0, 2),
        },
        Op::Insert {
            element: node("d", 33.0),
        },
        Op::Remove {
            class: Class::Load,
            id: "l1".into(),
        },
    ];
    let mut undo = Vec::new();
    for e in edits {
        undo.push(m.apply(e, &mut ix)?);
    }
    assert_eq!(
        m.loads.len(),
        1,
        "removal marks the row deleted and keeps it until compaction"
    );
    assert!(!m.alive(Class::Load, 0));
    for inv in undo.into_iter().rev() {
        m.apply(inv, &mut ix)?;
    }
    // Undoing the insert leaves the new node as a deleted row; the content is the same.
    assert_eq!(m.content_hash().ok(), before.content_hash().ok());
    assert_eq!(m.loads[0].p, 40.0);
    Ok(())
}

#[test]
fn refused_edits_leave_the_model_unchanged() -> Result<(), OpError> {
    let (mut m, mut ix) = build()?;
    let before = m.clone();
    assert!(matches!(
        m.apply(
            Op::Insert {
                element: node("a", 11.0)
            },
            &mut ix
        ),
        Err(OpError::Duplicate(Class::Node, _))
    ));
    assert!(matches!(
        m.apply(
            Op::Insert {
                element: line("x", 0, 9)
            },
            &mut ix
        ),
        Err(OpError::BadReference(..))
    ));
    assert!(matches!(
        m.apply(
            Op::Remove {
                class: Class::Node,
                id: "c".into()
            },
            &mut ix
        ),
        Err(OpError::InUse(Class::Node, _, 2))
    ));
    assert!(matches!(
        m.apply(
            Op::Set {
                class: Class::Load,
                id: "l1".into(),
                field: "p".into(),
                value: json!("lots")
            },
            &mut ix
        ),
        Err(OpError::BadField(..))
    ));
    assert!(matches!(
        m.apply(
            Op::Set {
                class: Class::Load,
                id: "l1".into(),
                field: "colour".into(),
                value: json!(1)
            },
            &mut ix
        ),
        Err(OpError::BadField(..))
    ));
    assert!(matches!(
        m.apply(
            Op::Set {
                class: Class::Line,
                id: "ab".into(),
                field: "node2".into(),
                value: json!(42)
            },
            &mut ix
        ),
        Err(OpError::BadReference(..))
    ));
    // A batch whose last edit fails rolls back the edits before it.
    let batch = Op::Batch {
        ops: vec![
            Op::Set {
                class: Class::Load,
                id: "l1".into(),
                field: "p".into(),
                value: json!(1.0),
            },
            Op::Insert {
                element: node("e", 11.0),
            },
            Op::Remove {
                class: Class::Node,
                id: "a".into(),
            },
        ],
    };
    assert!(m.apply(batch, &mut ix).is_err());
    assert_eq!(m.content_hash().ok(), before.content_hash().ok());
    assert!(ix.get(Class::Node, "e").is_none());
    Ok(())
}

#[test]
fn compaction_renumbers_references_and_snapshots_round_trip() -> Result<(), Box<dyn std::error::Error>> {
    let (mut m, mut ix) = build()?;
    // Remove node "a" after detaching line "ab", so later rows shift down by one.
    m.apply(
        Op::Remove {
            class: Class::Line,
            id: "ab".into(),
        },
        &mut ix,
    )?;
    m.apply(
        Op::Remove {
            class: Class::Node,
            id: "a".into(),
        },
        &mut ix,
    )?;
    let hash = m.content_hash()?;
    let bytes = m.to_snapshot()?;
    let back = Model::from_snapshot(&bytes)?;
    assert_eq!(back.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), ["b", "c"]);
    assert_eq!((back.lines[0].node1, back.lines[0].node2), (NodeRef(0), NodeRef(1)));
    assert_eq!(back.loads[0].node, NodeRef(1));
    assert!(back.deleted.is_empty());
    assert_eq!(
        back.content_hash()?,
        hash,
        "the hash describes content, not edit history"
    );
    let mut compacted = m.clone();
    compacted.compact();
    assert_eq!(compacted, back);
    assert!(matches!(
        Model::from_snapshot(b"not a model"),
        Err(SnapshotError::NotASnapshot)
    ));
    let mut wrong = bytes.clone();
    wrong[8] = 9;
    assert!(matches!(Model::from_snapshot(&wrong), Err(SnapshotError::Version(9))));
    Ok(())
}

#[test]
fn validation_names_the_element_and_the_fix() -> Result<(), OpError> {
    let (mut m, mut ix) = build()?;
    assert!(m.validate().is_empty(), "{:?}", m.validate());
    m.apply(
        Op::Set {
            class: Class::Line,
            id: "bc".into(),
            field: "x".into(),
            value: json!(0.0),
        },
        &mut ix,
    )?;
    m.apply(
        Op::Set {
            class: Class::Line,
            id: "bc".into(),
            field: "r".into(),
            value: json!(0.0),
        },
        &mut ix,
    )?;
    m.apply(
        Op::Set {
            class: Class::Node,
            id: "b".into(),
            field: "nominalKv".into(),
            value: json!(0.0),
        },
        &mut ix,
    )?;
    let issues = m.validate();
    assert_eq!(issues.len(), 2);
    assert!(issues.iter().all(|i| i.severity == Severity::Error));
    assert!(issues.iter().any(|i| i.id == "bc" && i.message.contains("switch")));
    assert!(
        issues
            .iter()
            .any(|i| i.id == "b" && i.message.contains("nominal voltage"))
    );
    Ok(())
}

#[test]
fn ops_travel_as_json() -> Result<(), Box<dyn std::error::Error>> {
    let op = Op::Batch {
        ops: vec![
            Op::Insert {
                element: node("z", 11.0),
            },
            Op::Remove {
                class: Class::Load,
                id: "l1".into(),
            },
        ],
    };
    let text = serde_json::to_string(&op)?;
    assert!(text.contains(r#""op":"insert""#) && text.contains(r#""class":"node""#));
    assert_eq!(serde_json::from_str::<Op>(&text)?, op);
    Ok(())
}
